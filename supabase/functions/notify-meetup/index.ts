// Sends a phone push notification to every other member when a meetup is posted.
// Called by a Supabase Database Webhook on INSERT into public.posts.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const APP_URL = Deno.env.get('APP_URL') ?? 'https://majetik.github.io/wc-caller/';
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

type Subscription = { endpoint: string; p256dh: string; auth: string; time_zone: string | null; locale: string | null };

function formatWhen(start: Date, minutes: number, timeZone: string | null, locale: string | null) {
  const end = new Date(start.getTime() + minutes * 60000);
  const options = { timeZone: timeZone ?? 'UTC' };
  const lang = locale ?? 'en-US';
  try {
    const day = start.toLocaleDateString(lang, { ...options, weekday: 'short', month: 'short', day: 'numeric' });
    const time = (d: Date) => d.toLocaleTimeString(lang, { ...options, hour: 'numeric', minute: '2-digit' });
    return `${day}, ${time(start)}–${time(end)}`;
  } catch {
    return start.toUTCString();
  }
}

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { type, table, record } = await req.json();
  if (type !== 'INSERT' || table !== 'posts' || !record?.meetup_start) {
    return Response.json({ skipped: true });
  }

  const [{ data: author }, { data: subscriptions, error }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', record.author_id).maybeSingle(),
    supabase.from('push_subscriptions').select('endpoint, p256dh, auth, time_zone, locale').neq('user_id', record.author_id),
  ]);
  if (error) {
    console.error(error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const start = new Date(record.meetup_start);
  const host = author?.display_name ?? 'Someone';
  const text = String(record.body ?? '').trim();
  const snippet = text.length > 100 ? `${text.slice(0, 97)}…` : text;
  // Don't deliver after the meetup has started.
  const ttl = Math.max(60, Math.min(MAX_TTL_SECONDS, Math.floor((start.getTime() - Date.now()) / 1000)));

  const results = await Promise.allSettled((subscriptions as Subscription[]).map((sub) => {
    const when = formatWhen(start, record.meetup_minutes, sub.time_zone, sub.locale);
    const payload = JSON.stringify({
      title: `${host} invited you to a meetup`,
      body: snippet ? `${when} · ${snippet}` : when,
      url: `${APP_URL}#post-${record.id}`,
      tag: `meetup-${record.id}`,
    });
    return webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { TTL: ttl, urgency: 'high' },
    );
  }));

  // Phones that turned notifications off or uninstalled: forget them.
  const expired: string[] = [];
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') return;
    const status = (result.reason as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) expired.push((subscriptions as Subscription[])[i].endpoint);
    else {
      failed += 1;
      console.error('push failed', status, (result.reason as Error)?.message);
    }
  });
  if (expired.length) await supabase.from('push_subscriptions').delete().in('endpoint', expired);

  return Response.json({ sent: results.length - expired.length - failed, expired: expired.length, failed });
});
