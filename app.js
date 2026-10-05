import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_CHARS = 299;
const PAGE_SIZE = 20;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
const APP_URL = location.origin + location.pathname;
const POST_FIELDS = `id, body, media_path, media_type, meetup_start, meetup_minutes, created_at, author_id,
  author:profiles!posts_author_id_fkey(display_name, avatar_url),
  likes(count), comments(count),
  rsvps(user_id, status, profile:profiles(display_name))`;
const COMMENT_FIELDS = 'id, post_id, body, created_at, author_id, author:profiles!comments_author_id_fkey(display_name, avatar_url)';
const NOTIFICATION_FIELDS = `id, kind, created_at, read_at, post_id,
  actor:profiles!notifications_actor_id_fkey(display_name, avatar_url),
  post:posts(body, meetup_start, meetup_minutes)`;
const BANNER_DISMISSED_KEY = 'wc-push-banner-dismissed';

const state = {
  user: null,
  profile: null,
  posts: new Map(),      // post id -> post row
  myLikes: new Set(),    // post ids the signed-in user has liked
  pending: new Set(),    // in-flight like/rsvp actions, to ignore double taps
  oldestId: null,
  loading: false,
  reachedEnd: false,
  newCount: 0,
  threadPostId: null,
  threadComments: [],
  unread: 0,
  notificationsChannel: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  feed: $('feed'),
  status: $('feed-status'),
  sentinel: $('sentinel'),
  account: $('account'),
  fab: $('fab'),
  newPosts: $('new-posts'),
  toast: $('toast'),
  composer: $('composer'),
  thread: $('thread'),
  threadPost: $('thread-post'),
  threadComments: $('thread-comments'),
  threadFoot: $('thread-foot'),
  bell: $('bell'),
  bellCount: $('bell-count'),
  pushBanner: $('push-banner'),
  inbox: $('inbox'),
  inboxList: $('inbox-list'),
  pushSettings: $('push-settings'),
};

// ─── Small helpers ───────────────────────────────────────────────────────

const ICONS = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.6-4.5-9.4-9.3C1.3 7.8 3.5 4.5 7 4.5c2 0 3.5 1.1 5 2.9 1.5-1.8 3-2.9 5-2.9 3.5 0 5.7 3.3 4.4 6.7-1.8 4.8-9.4 9.3-9.4 9.3z"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M20.5 11.5a8 8 0 0 1-11.8 7l-4.2 1.3 1.3-4A8 8 0 1 1 20.5 11.5z"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 15.5-4.8-4.8L7 19.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M10 4h4M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = ICONS[name]; // trusted constant markup only
  return span;
}

// Builds an element. Text children are always inserted as text, never as HTML.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false && c !== ''));
  return el;
}

const charCount = (text) => [...text].length; // matches Postgres char_length
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mediaUrl = (path) => sb.storage.from('media').getPublicUrl(path).data.publicUrl;

function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso)) / 1000;
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return [hours && `${hours} h`, mins && `${mins} min`].filter(Boolean).join(' ');
}

function formatMeetup(start, minutes) {
  const end = new Date(start.getTime() + minutes * 60000);
  const day = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time(start)} – ${time(end)}`;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<]+/gi;

function linkify(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,!?;:)\]'"]+$/, '');
    frag.append(text.slice(last, match.index));
    const href = url.toLowerCase().startsWith('http') ? url : `https://${url}`;
    frag.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = match.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function avatar(profile) {
  if (profile?.avatar_url) {
    return h('img', { class: 'avatar', src: profile.avatar_url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  }
  const initial = (profile?.display_name || '?').trim().charAt(0).toUpperCase();
  return h('span', { class: 'avatar avatar-fallback', 'aria-hidden': 'true' }, initial);
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
}

function setStatus(text) {
  els.status.textContent = text;
}

// ─── Google Calendar ─────────────────────────────────────────────────────

function calendarUrl(post) {
  const start = new Date(post.meetup_start);
  const end = new Date(start.getTime() + post.meetup_minutes * 60000);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const host = post.author?.display_name || 'a friend';
  const firstLine = post.body.trim().split('\n')[0];
  const title = firstLine ? (firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine) : `Meetup with ${host}`;
  const details = `${post.body.trim() ? `${post.body.trim()}\n\n` : ''}Invite from ${host} on WC Caller: ${APP_URL}`;
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${stamp(start)}/${stamp(end)}`, details });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// ─── Rendering posts ─────────────────────────────────────────────────────

function renderPost(post) {
  const likeCount = post.likes?.[0]?.count ?? 0;
  const commentCount = post.comments?.[0]?.count ?? 0;
  const liked = state.myLikes.has(post.id);
  const mine = state.user?.id === post.author_id;

  return h('article', { class: 'post', 'data-id': post.id },
    avatar(post.author),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-head' },
        h('span', { class: 'post-author' }, post.author?.display_name || 'Member'),
        h('time', { class: 'post-time', datetime: post.created_at, title: new Date(post.created_at).toLocaleString() }, timeAgo(post.created_at)),
        mine && h('button', { type: 'button', class: 'icon-btn small post-delete', 'aria-label': 'Delete post', onclick: () => deletePost(post.id) }, icon('trash')),
      ),
      post.body && h('p', { class: 'post-body' }, linkify(post.body)),
      post.media_path && renderMedia(post),
      post.meetup_start && renderMeetup(post),
      h('div', { class: 'post-actions' },
        h('button', {
          type: 'button',
          class: `action like${liked ? ' active' : ''}`,
          'aria-pressed': String(liked),
          'aria-label': `Like, ${likeCount}`,
          onclick: () => toggleLike(post.id),
        }, icon('heart'), h('span', {}, likeCount ? String(likeCount) : '')),
        h('button', {
          type: 'button',
          class: 'action',
          'aria-label': `Comments, ${commentCount}`,
          onclick: () => openThread(post.id),
        }, icon('comment'), h('span', {}, commentCount ? String(commentCount) : '')),
      ),
    ),
  );
}

function renderMedia(post) {
  const src = mediaUrl(post.media_path);
  if (post.media_type === 'video') {
    return h('video', { class: 'post-media', src: `${src}#t=0.1`, controls: true, playsinline: true, preload: 'metadata' });
  }
  return h('a', { class: 'post-media-link', href: src, target: '_blank', rel: 'noopener' },
    h('img', { class: 'post-media', src, alt: '', loading: 'lazy' }));
}

function renderMeetup(post) {
  const start = new Date(post.meetup_start);
  const end = new Date(start.getTime() + post.meetup_minutes * 60000);
  const over = end < new Date();
  const rsvps = post.rsvps || [];
  const coming = rsvps.filter((r) => r.status === 'coming');
  const notCount = rsvps.length - coming.length;
  const myStatus = rsvps.find((r) => r.user_id === state.user?.id)?.status;

  const rsvpButton = (status, label, count) => h('button', {
    type: 'button',
    class: `rsvp-btn ${status}${myStatus === status ? ' active' : ''}`,
    'aria-pressed': String(myStatus === status),
    disabled: over,
    onclick: () => setRsvp(post.id, status),
  }, label, count ? h('span', { class: 'rsvp-count' }, String(count)) : null);

  return h('div', { class: `meetup${over ? ' over' : ''}` },
    h('div', { class: 'meetup-head' },
      icon('calendar'),
      h('div', {},
        h('div', { class: 'meetup-label' }, over ? 'Meetup · ended' : 'Meetup invite'),
        h('div', { class: 'meetup-when' }, formatMeetup(start, post.meetup_minutes)),
        h('div', { class: 'meetup-duration' }, formatDuration(post.meetup_minutes)),
      ),
    ),
    h('div', { class: 'rsvp-row' },
      rsvpButton('coming', 'Coming', coming.length),
      rsvpButton('not', 'Not', notCount),
    ),
    coming.length > 0 && h('p', { class: 'meetup-who' },
      h('strong', {}, 'Coming: '), coming.map((r) => r.profile?.display_name || 'Member').join(', ')),
    myStatus === 'coming' && !over && h('a', { class: 'meetup-cal', href: calendarUrl(post), target: '_blank', rel: 'noopener' }, 'Add to Google Calendar'),
  );
}

function updateCard(id) {
  const post = state.posts.get(id);
  if (!post) return;
  els.feed.querySelector(`.post[data-id="${id}"]`)?.replaceWith(renderPost(post));
  if (state.threadPostId === id) els.threadPost.replaceChildren(renderPost(post));
}

function removePost(id) {
  state.posts.delete(id);
  els.feed.querySelector(`.post[data-id="${id}"]`)?.remove();
  if (state.threadPostId === id) els.thread.close();
  if (!state.posts.size && state.reachedEnd) setStatus('No posts yet. Be the first!');
}

// ─── Loading the feed ────────────────────────────────────────────────────

async function loadMyLikes(ids) {
  if (!state.user || !ids.length) return;
  const { data } = await sb.from('likes').select('post_id').eq('user_id', state.user.id).in('post_id', ids);
  for (const row of data || []) state.myLikes.add(row.post_id);
}

async function loadMore() {
  if (state.loading || state.reachedEnd) return;
  state.loading = true;
  setStatus('Loading…');

  let query = sb.from('posts').select(POST_FIELDS).order('id', { ascending: false }).limit(PAGE_SIZE);
  if (state.oldestId) query = query.lt('id', state.oldestId);
  const { data, error } = await query;

  if (error) {
    state.loading = false;
    console.error(error);
    setStatus("Couldn't load posts. Tap WC Caller at the top to try again.");
    return;
  }

  await loadMyLikes(data.map((p) => p.id));
  for (const post of data) {
    state.posts.set(post.id, post);
    els.feed.append(renderPost(post));
  }
  if (data.length) state.oldestId = data[data.length - 1].id;
  state.loading = false;

  if (data.length < PAGE_SIZE) {
    state.reachedEnd = true;
    setStatus(state.posts.size ? "You're all caught up." : 'No posts yet. Be the first!');
  } else {
    setStatus('');
    requestAnimationFrame(() => { if (sentinelNearViewport()) loadMore(); });
  }
}

function sentinelNearViewport() {
  return els.sentinel.getBoundingClientRect().top < window.innerHeight + 800;
}

function reloadFeed() {
  state.posts.clear();
  state.oldestId = null;
  state.reachedEnd = false;
  state.newCount = 0;
  els.newPosts.hidden = true;
  els.feed.replaceChildren();
  window.scrollTo({ top: 0 });
  loadMore();
}

// ─── Likes and RSVPs ─────────────────────────────────────────────────────

async function toggleLike(id) {
  if (!state.user) return signIn();
  const key = `like:${id}`;
  if (state.pending.has(key)) return;
  state.pending.add(key);

  const post = state.posts.get(id);
  const wasLiked = state.myLikes.has(id);
  const apply = (liked) => {
    liked ? state.myLikes.add(id) : state.myLikes.delete(id);
    const count = post.likes?.[0]?.count ?? 0;
    post.likes = [{ count: Math.max(0, count + (liked ? 1 : -1)) }];
    updateCard(id);
  };

  apply(!wasLiked);
  const { error } = wasLiked
    ? await sb.from('likes').delete().match({ post_id: id, user_id: state.user.id })
    : await sb.from('likes').insert({ post_id: id, user_id: state.user.id });
  if (error) {
    apply(wasLiked);
    toast("Couldn't update the like. Try again.");
  }
  state.pending.delete(key);
}

async function setRsvp(id, status) {
  if (!state.user) return signIn();
  const key = `rsvp:${id}`;
  if (state.pending.has(key)) return;

  const post = state.posts.get(id);
  const current = post.rsvps?.find((r) => r.user_id === state.user.id)?.status;
  const next = current === status ? null : status;

  // Open the calendar right away, while we still have the tap (otherwise popup blockers step in).
  if (next === 'coming') window.open(calendarUrl(post), '_blank', 'noopener');

  state.pending.add(key);
  const previous = post.rsvps;
  post.rsvps = (post.rsvps || []).filter((r) => r.user_id !== state.user.id);
  if (next) post.rsvps.push({ user_id: state.user.id, status: next, profile: { display_name: state.profile?.display_name } });
  updateCard(id);

  const { error } = next
    ? await sb.from('rsvps').upsert({ post_id: id, user_id: state.user.id, status: next, updated_at: new Date().toISOString() })
    : await sb.from('rsvps').delete().match({ post_id: id, user_id: state.user.id });
  if (error) {
    post.rsvps = previous;
    updateCard(id);
    toast("Couldn't save your answer. Try again.");
  }
  state.pending.delete(key);
}

async function deletePost(id) {
  const post = state.posts.get(id);
  if (!post || !confirm('Delete this post?')) return;
  const { error } = await sb.from('posts').delete().eq('id', id);
  if (error) return toast("Couldn't delete the post.");
  if (post.media_path) await sb.storage.from('media').remove([post.media_path]);
  removePost(id);
}

// ─── Comment thread ──────────────────────────────────────────────────────

async function openThread(id) {
  state.threadPostId = id;
  state.threadComments = [];
  els.threadPost.replaceChildren(renderPost(state.posts.get(id)));
  els.threadComments.replaceChildren(h('p', { class: 'status' }, 'Loading comments…'));
  renderThreadFoot();
  if (!els.thread.open) els.thread.showModal();
  await loadComments(id);
}

async function loadComments(id) {
  const { data, error } = await sb.from('comments').select(COMMENT_FIELDS).eq('post_id', id).order('created_at');
  if (state.threadPostId !== id) return;
  if (error) {
    els.threadComments.replaceChildren(h('p', { class: 'status' }, "Couldn't load comments."));
    return;
  }
  state.threadComments = data;
  renderComments();
}

function renderComments() {
  if (!state.threadComments.length) {
    els.threadComments.replaceChildren(h('p', { class: 'status' }, 'No comments yet. Start the conversation.'));
    return;
  }
  els.threadComments.replaceChildren(...state.threadComments.map((c) =>
    h('div', { class: 'comment' },
      avatar(c.author),
      h('div', { class: 'post-main' },
        h('div', { class: 'post-head' },
          h('span', { class: 'post-author' }, c.author?.display_name || 'Member'),
          h('time', { class: 'post-time', datetime: c.created_at }, timeAgo(c.created_at)),
          c.author_id === state.user?.id && h('button', {
            type: 'button', class: 'icon-btn small post-delete', 'aria-label': 'Delete comment', onclick: () => deleteComment(c),
          }, icon('trash')),
        ),
        h('p', { class: 'post-body' }, linkify(c.body)),
      ),
    )));
}

function renderThreadFoot() {
  if (!state.user) {
    els.threadFoot.replaceChildren(
      h('button', { type: 'button', class: 'primary-btn wide', onclick: signIn }, 'Sign in to comment'));
    return;
  }
  const input = h('textarea', { rows: '1', maxlength: String(MAX_CHARS), placeholder: 'Add a comment', 'aria-label': 'Comment' });
  const send = h('button', { type: 'submit', class: 'primary-btn', disabled: true }, 'Reply');
  input.addEventListener('input', () => {
    send.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  const form = h('form', { class: 'comment-form' }, input, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    const postId = state.threadPostId;
    send.disabled = true;
    const { data, error } = await sb.from('comments')
      .insert({ post_id: postId, author_id: state.user.id, body })
      .select(COMMENT_FIELDS).single();
    if (error) {
      send.disabled = false;
      return toast("Couldn't post your comment.");
    }
    input.value = '';
    input.style.height = 'auto';
    if (state.threadPostId === postId && !state.threadComments.some((c) => c.id === data.id)) {
      state.threadComments.push(data);
      renderComments();
      els.threadComments.lastElementChild?.scrollIntoView({ block: 'nearest' });
    }
    refreshPost(postId);
  });
  els.threadFoot.replaceChildren(form);
}

async function deleteComment(comment) {
  if (!confirm('Delete this comment?')) return;
  const { error } = await sb.from('comments').delete().eq('id', comment.id);
  if (error) return toast("Couldn't delete the comment.");
  state.threadComments = state.threadComments.filter((c) => c.id !== comment.id);
  renderComments();
  refreshPost(comment.post_id);
}

// ─── Composer ────────────────────────────────────────────────────────────

const composer = { file: null, previewUrl: null, meetup: false, busy: false };
const form = {
  root: $('composer-form'),
  text: $('post-text'),
  count: $('char-count'),
  submit: $('post-btn'),
  fileInput: $('file-input'),
  attach: $('attach-btn'),
  preview: $('media-preview'),
  meetupBtn: $('meetup-btn'),
  meetupFields: $('meetup-fields'),
  meetupError: $('meetup-error'),
  date: $('meetup-date'),
  time: $('meetup-time'),
  duration: $('meetup-duration'),
};

function openComposer() {
  if (!state.user) return signIn();
  form.root.reset();
  clearMedia();
  setMeetup(false);
  updateComposer();
  els.composer.showModal();
  form.text.focus();
}

function meetupStart() {
  if (!form.date.value || !form.time.value) return null;
  return new Date(`${form.date.value}T${form.time.value}`);
}

function updateComposer() {
  const remaining = MAX_CHARS - charCount(form.text.value);
  form.count.textContent = String(remaining);
  form.count.classList.toggle('warn', remaining <= 20 && remaining >= 0);
  form.count.classList.toggle('over', remaining < 0);

  const start = composer.meetup ? meetupStart() : null;
  const meetupValid = !composer.meetup || (start && start > new Date());
  form.meetupError.hidden = !composer.meetup || !start || meetupValid;

  const hasContent = form.text.value.trim() || composer.file || composer.meetup;
  form.submit.disabled = composer.busy || remaining < 0 || !hasContent || !meetupValid;
}

function setMeetup(on) {
  composer.meetup = on;
  form.meetupFields.hidden = !on;
  form.meetupBtn.setAttribute('aria-pressed', String(on));
  form.meetupBtn.classList.toggle('active', on);
  if (on && !form.date.value) {
    const suggested = new Date();
    suggested.setHours(suggested.getHours() + 2, 0, 0, 0);
    form.date.value = localDate(suggested);
    form.time.value = localTime(suggested);
  }
  form.date.min = localDate(new Date());
  updateComposer();
}

function setMedia(file) {
  clearMedia();
  composer.file = file;
  composer.previewUrl = URL.createObjectURL(file);
  const media = file.type.startsWith('video/')
    ? h('video', { src: composer.previewUrl, controls: true, playsinline: true, muted: true })
    : h('img', { src: composer.previewUrl, alt: '' });
  form.preview.replaceChildren(media,
    h('button', { type: 'button', class: 'remove-media', 'aria-label': 'Remove attachment', onclick: () => { clearMedia(); updateComposer(); } }, '×'));
  form.preview.hidden = false;
  updateComposer();
}

function clearMedia() {
  if (composer.previewUrl) URL.revokeObjectURL(composer.previewUrl);
  composer.file = null;
  composer.previewUrl = null;
  form.preview.replaceChildren();
  form.preview.hidden = true;
}

// Phone photos are often 5–10 MB; resize to keep uploads fast and storage small.
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

async function submitPost(e) {
  e.preventDefault();
  if (form.submit.disabled) return;
  composer.busy = true;
  form.submit.textContent = composer.file ? 'Uploading…' : 'Posting…';
  updateComposer();

  let uploadedPath = null;
  try {
    const row = { author_id: state.user.id, body: form.text.value.trim() };

    if (composer.file) {
      const isVideo = composer.file.type.startsWith('video/');
      const upload = isVideo ? composer.file : await shrinkImage(composer.file);
      if (upload.size > MAX_UPLOAD_BYTES) throw new Error('Files must be under 50 MB.');
      const ext = (upload.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from('media').upload(path, upload, { contentType: upload.type, cacheControl: '31536000' });
      if (error) throw error;
      uploadedPath = path;
      row.media_path = path;
      row.media_type = isVideo ? 'video' : 'image';
    }

    if (composer.meetup) {
      row.meetup_start = meetupStart().toISOString();
      row.meetup_minutes = Number(form.duration.value);
    }

    const { data, error } = await sb.from('posts').insert(row).select(POST_FIELDS).single();
    if (error) throw error;
    uploadedPath = null;

    state.posts.set(data.id, data);
    els.feed.prepend(renderPost(data));
    if (state.reachedEnd) setStatus("You're all caught up.");
    els.composer.close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    if (uploadedPath) sb.storage.from('media').remove([uploadedPath]);
    toast(err.message ? `Couldn't post: ${err.message}` : "Couldn't post. Try again.");
  } finally {
    composer.busy = false;
    form.submit.textContent = 'Post';
    updateComposer();
  }
}

form.root.addEventListener('submit', submitPost);
form.text.addEventListener('input', updateComposer);
form.date.addEventListener('input', updateComposer);
form.time.addEventListener('input', updateComposer);
form.attach.addEventListener('click', () => form.fileInput.click());
form.meetupBtn.addEventListener('click', () => setMeetup(!composer.meetup));
form.fileInput.addEventListener('change', () => {
  const file = form.fileInput.files[0];
  form.fileInput.value = '';
  if (!file) return;
  if (!/^(image|video)\//.test(file.type)) return toast('Pick a photo or a video.');
  if (file.type.startsWith('video/') && file.size > MAX_UPLOAD_BYTES) return toast('Videos must be under 50 MB. Try a shorter clip.');
  setMedia(file);
});

// ─── Phone push notifications ────────────────────────────────────────────

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function base64UrlToBytes(value) {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

// 'on' | 'off' | 'blocked' | 'ios-install' | 'unsupported'
async function pushStatus() {
  if (!pushSupported) return isIOS && !isStandalone ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission === 'granted' && await currentSubscription()) return 'on';
  return 'off';
}

async function saveSubscription(subscription) {
  const { endpoint, keys } = subscription.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({
    endpoint,
    user_id: state.user.id,
    p256dh: keys.p256dh,
    auth: keys.auth,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
  });
  if (error) throw error;
}

async function enablePush() {
  if (!state.user) return signIn();
  try {
    // Must be the first await: iPhones only show the prompt directly after a tap.
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription())
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY) });
      await saveSubscription(subscription);
      toast("Notifications are on. You'll hear about new meetups.");
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't turn on notifications. Try again.");
  }
  await renderPushUi();
}

async function disablePush() {
  const subscription = await currentSubscription();
  if (subscription) {
    await sb.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    await subscription.unsubscribe();
  }
  await renderPushUi();
}

// Re-save on each visit in case the browser rotated the subscription.
async function syncPushSubscription() {
  if (!state.user || !pushSupported || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription();
  if (subscription) saveSubscription(subscription).catch(console.error);
}

function bannerDismissed() {
  try { return localStorage.getItem(BANNER_DISMISSED_KEY) === '1'; } catch { return false; }
}

function dismissBanner() {
  try { localStorage.setItem(BANNER_DISMISSED_KEY, '1'); } catch { /* private mode */ }
  els.pushBanner.hidden = true;
}

function pushCard(status, inBanner) {
  const notNow = inBanner && h('button', { type: 'button', class: 'text-btn', onclick: dismissBanner }, 'Not now');
  switch (status) {
    case 'on':
      return [
        h('div', { class: 'banner-title' }, 'Notifications are on'),
        h('p', { class: 'muted' }, 'This device gets a notification when someone posts a meetup.'),
        h('button', { type: 'button', class: 'text-btn', onclick: disablePush }, 'Turn off on this device'),
      ];
    case 'off':
      return [
        h('div', { class: 'banner-title' }, 'Get notified about meetups'),
        h('p', { class: 'muted' }, 'Get a notification on this device when someone posts a meetup invite.'),
        h('div', { class: 'banner-actions' },
          h('button', { type: 'button', class: 'primary-btn', onclick: enablePush }, 'Turn on notifications'),
          notNow),
      ];
    case 'ios-install':
      return [
        h('div', { class: 'banner-title' }, 'Get meetup notifications on iPhone'),
        h('p', { class: 'muted' }, 'iPhones only allow notifications from apps on your Home Screen:'),
        h('ol', {},
          h('li', {}, 'Tap the Share button (the square with an arrow).'),
          h('li', {}, 'Choose “Add to Home Screen”.'),
          h('li', {}, 'Open WC Caller from the new icon and turn on notifications.')),
        notNow && h('div', { class: 'banner-actions' }, notNow),
      ];
    case 'blocked':
      return [
        h('div', { class: 'banner-title' }, 'Notifications are blocked'),
        h('p', { class: 'muted' }, 'Allow notifications for WC Caller in your browser or phone settings, then come back here.'),
      ];
    case 'unsupported':
      return [
        h('div', { class: 'banner-title' }, 'Notifications unavailable'),
        h('p', { class: 'muted' }, "This browser can't show notifications. Try Chrome on Android, or add WC Caller to your iPhone Home Screen."),
      ];
    default:
      return [];
  }
}

async function renderPushUi() {
  const status = state.user ? await pushStatus() : null;
  els.pushSettings.replaceChildren(...pushCard(status, false));
  const showBanner = Boolean(state.user) && !bannerDismissed() && (status === 'off' || status === 'ios-install');
  els.pushBanner.replaceChildren(...(showBanner ? pushCard(status, true) : []));
  els.pushBanner.hidden = !showBanner;
}

// ─── In-app notifications (the bell) ─────────────────────────────────────

function setUnread(count) {
  state.unread = count;
  els.bellCount.textContent = count > 9 ? '9+' : String(count);
  els.bellCount.hidden = count === 0;
  els.bell.setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
}

async function refreshUnread() {
  if (!state.user) return setUnread(0);
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  setUnread(count ?? 0);
}

async function openInbox() {
  els.inboxList.replaceChildren(h('p', { class: 'status' }, 'Loading…'));
  renderPushUi();
  els.inbox.showModal();
  await loadInbox();
  markAllRead();
}

async function loadInbox() {
  const { data, error } = await sb.from('notifications').select(NOTIFICATION_FIELDS)
    .order('created_at', { ascending: false }).limit(50);
  if (error) {
    console.error(error);
    els.inboxList.replaceChildren(h('p', { class: 'status' }, "Couldn't load notifications."));
    return;
  }
  if (!data.length) {
    els.inboxList.replaceChildren(h('p', { class: 'status' }, 'Nothing yet. New meetup invites will show up here.'));
    return;
  }
  els.inboxList.replaceChildren(...data.map(renderNotification));
}

function renderNotification(n) {
  const meetup = n.post?.meetup_start ? formatMeetup(new Date(n.post.meetup_start), n.post.meetup_minutes) : null;
  return h('button', {
    type: 'button',
    class: `inbox-item${n.read_at ? '' : ' unread'}`,
    onclick: () => openPostById(n.post_id),
  },
    avatar(n.actor),
    h('div', {},
      h('p', { class: 'inbox-text' }, h('strong', {}, n.actor?.display_name || 'Someone'), ' invited you to a meetup'),
      h('div', { class: 'inbox-meta' }, [meetup, timeAgo(n.created_at)].filter(Boolean).join(' · ')),
    ),
  );
}

async function markAllRead() {
  if (!state.unread) return;
  setUnread(0);
  await sb.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
}

function subscribeNotifications() {
  if (state.notificationsChannel) {
    sb.removeChannel(state.notificationsChannel);
    state.notificationsChannel = null;
  }
  if (!state.user) return;
  state.notificationsChannel = sb.channel(`notifications:${state.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.user.id}` }, () => {
      setUnread(state.unread + 1);
      if (els.inbox.open) loadInbox().then(markAllRead);
    })
    .subscribe();
}

// Opens a post's thread (with its Coming / Not buttons), even if it isn't loaded in the feed.
async function openPostById(id) {
  if (!id) return;
  if (!state.posts.has(id)) {
    const { data } = await sb.from('posts').select(POST_FIELDS).eq('id', id).maybeSingle();
    if (!data) return toast('That post was deleted.');
    state.posts.set(id, data);
    await loadMyLikes([id]);
  }
  if (els.inbox.open) els.inbox.close();
  openThread(id);
}

// Links like …/wc-caller/#post-42 (used by notifications) open that post.
function openFromHash() {
  const match = location.hash.match(/^#post-(\d+)$/);
  if (!match) return;
  history.replaceState(null, '', location.pathname + location.search);
  openPostById(Number(match[1]));
}

// ─── Accounts ────────────────────────────────────────────────────────────

function signIn() {
  sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: APP_URL } });
}

async function signOut() {
  // Stop this device's notifications so the next person to sign in here doesn't get them.
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) {
    await sb.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    await subscription.unsubscribe();
  }
  await sb.auth.signOut();
}

function renderAccount() {
  els.account.replaceChildren();
  if (!state.user) {
    els.account.append(h('button', { type: 'button', class: 'primary-btn small', onclick: signIn }, 'Sign in'));
    return;
  }
  const menu = h('div', { class: 'menu', hidden: true },
    h('div', { class: 'menu-name' }, state.profile?.display_name || ''),
    h('button', { type: 'button', class: 'menu-item', onclick: signOut }, 'Sign out'));
  const button = h('button', {
    type: 'button',
    class: 'avatar-btn',
    'aria-label': 'Account menu',
    onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; },
  }, avatar(state.profile));
  els.account.append(button, menu);
}

async function onUserChanged(user) {
  state.user = user;
  state.profile = null;
  state.myLikes.clear();
  if (user) {
    const { data } = await sb.from('profiles').select('display_name, avatar_url').eq('id', user.id).maybeSingle();
    state.profile = data ?? { display_name: user.user_metadata?.full_name || 'Me', avatar_url: user.user_metadata?.avatar_url };
    await loadMyLikes([...state.posts.keys()]);
  }
  renderAccount();
  els.fab.hidden = !user;
  els.bell.hidden = !user;
  refreshUnread();
  subscribeNotifications();
  syncPushSubscription();
  renderPushUi();
  for (const id of state.posts.keys()) updateCard(id);
  if (state.threadPostId) {
    renderThreadFoot();
    renderComments();
  }
}

sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user ?? null;
  if (user?.id === state.user?.id) return;
  // Supabase recommends not awaiting other calls inside this callback.
  setTimeout(() => onUserChanged(user), 0);
});

// ─── Live updates ────────────────────────────────────────────────────────

const refreshTimers = new Map();
function refreshPost(id) {
  if (!id || !state.posts.has(id)) return;
  clearTimeout(refreshTimers.get(id));
  refreshTimers.set(id, setTimeout(async () => {
    refreshTimers.delete(id);
    const { data } = await sb.from('posts').select(POST_FIELDS).eq('id', id).maybeSingle();
    if (data && state.posts.has(id)) {
      state.posts.set(id, data);
      updateCard(id);
    }
  }, 300));
}

function changedPostId(payload) {
  return payload.new?.post_id ?? payload.old?.post_id;
}

sb.channel('feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, ({ new: post }) => {
    if (state.posts.has(post.id) || post.author_id === state.user?.id) return;
    state.newCount += 1;
    els.newPosts.textContent = `${state.newCount} new post${state.newCount > 1 ? 's' : ''}`;
    els.newPosts.hidden = false;
  })
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, ({ old }) => removePost(old.id))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' }, (p) => refreshPost(changedPostId(p)))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'rsvps' }, (p) => refreshPost(changedPostId(p)))
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, ({ new: comment }) => {
    refreshPost(comment.post_id);
    if (state.threadPostId === comment.post_id && !state.threadComments.some((c) => c.id === comment.id)) {
      loadComments(comment.post_id);
    }
  })
  .subscribe();

// ─── Page wiring ─────────────────────────────────────────────────────────

document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(icon(el.dataset.icon)));
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
document.addEventListener('click', () => document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; }));

els.thread.addEventListener('click', (e) => { if (e.target === els.thread) els.thread.close(); });
els.inbox.addEventListener('click', (e) => { if (e.target === els.inbox) els.inbox.close(); });
els.thread.addEventListener('close', () => { state.threadPostId = null; state.threadComments = []; });
els.fab.addEventListener('click', openComposer);
els.bell.addEventListener('click', openInbox);
els.newPosts.addEventListener('click', reloadFeed);
$('brand').addEventListener('click', reloadFeed);

// Keep full-screen sheets within the area above the on-screen keyboard.
function fitSheetsToViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty('--vv-height', `${vv.height}px`);
  document.documentElement.style.setProperty('--vv-top', `${vv.offsetTop}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitSheetsToViewport);
  window.visualViewport.addEventListener('scroll', fitSheetsToViewport);
  fitSheetsToViewport();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
  // A notification was tapped while the app was already open.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open-url') location.hash = new URL(event.data.url).hash;
  });
}
window.addEventListener('hashchange', openFromHash);
openFromHash();

setInterval(() => {
  document.querySelectorAll('time.post-time').forEach((t) => { t.textContent = timeAgo(t.getAttribute('datetime')); });
}, 60000);

renderAccount();
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) loadMore();
}, { rootMargin: '800px' }).observe(els.sentinel);
