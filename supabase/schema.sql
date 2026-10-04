-- WC Caller database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run once on a fresh project.

-- ─── Tables ────────────────────────────────────────────────────────────────

-- One row per signed-in person, filled in automatically from their Google account.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Member',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.posts (
  id bigint generated always as identity primary key,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null default '' check (char_length(body) <= 299),
  media_path text,
  media_type text check (media_type in ('image', 'video')),
  meetup_start timestamptz,
  meetup_minutes int check (meetup_minutes between 15 and 1440),
  created_at timestamptz not null default now(),
  constraint media_complete check ((media_path is null) = (media_type is null)),
  constraint meetup_complete check ((meetup_start is null) = (meetup_minutes is null)),
  constraint not_empty check (char_length(body) > 0 or media_path is not null or meetup_start is not null)
);
create index posts_feed_idx on public.posts (id desc);

create table public.likes (
  post_id bigint not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index likes_user_idx on public.likes (user_id);

create table public.comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 299),
  created_at timestamptz not null default now()
);
create index comments_post_idx on public.comments (post_id, created_at);

create table public.rsvps (
  post_id bigint not null references public.posts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  status text not null check (status in ('coming', 'not')),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ─── Create a profile whenever someone signs in for the first time ────────

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Anyone who already signed in before this script ran.
insert into public.profiles (id, display_name, avatar_url)
select id,
       coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', split_part(email, '@', 1)),
       raw_user_meta_data ->> 'avatar_url'
from auth.users
on conflict (id) do nothing;

-- ─── Access rules (Row Level Security) ─────────────────────────────────────
-- Everyone can read the feed. Only signed-in people can write, and only as themselves.

alter table public.profiles enable row level security;
alter table public.posts    enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;
alter table public.rsvps    enable row level security;

create policy "profiles are public"      on public.profiles for select using (true);
create policy "edit own profile"         on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "posts are public"         on public.posts for select using (true);
create policy "create own posts"         on public.posts for insert to authenticated with check (author_id = auth.uid());
create policy "delete own posts"         on public.posts for delete to authenticated using (author_id = auth.uid());

create policy "likes are public"         on public.likes for select using (true);
create policy "like as yourself"         on public.likes for insert to authenticated with check (user_id = auth.uid());
create policy "unlike your own"          on public.likes for delete to authenticated using (user_id = auth.uid());

create policy "comments are public"      on public.comments for select using (true);
create policy "comment as yourself"      on public.comments for insert to authenticated with check (author_id = auth.uid());
create policy "delete own comments"      on public.comments for delete to authenticated using (author_id = auth.uid());

create policy "rsvps are public"         on public.rsvps for select using (true);
create policy "rsvp as yourself"         on public.rsvps for insert to authenticated with check (user_id = auth.uid());
create policy "change own rsvp"          on public.rsvps for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own rsvp"          on public.rsvps for delete to authenticated using (user_id = auth.uid());

grant select on public.profiles, public.posts, public.likes, public.comments, public.rsvps to anon, authenticated;
grant update on public.profiles to authenticated;
grant insert, delete on public.posts, public.likes, public.comments to authenticated;
grant insert, update, delete on public.rsvps to authenticated;

-- ─── Photo and video storage ───────────────────────────────────────────────
-- Public bucket (anyone can view media), 50 MB per file, images and videos only.
-- People can only upload into a folder named after their own user id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['image/*', 'video/*'])
on conflict (id) do nothing;

create policy "upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own media" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and owner_id = auth.uid()::text);

-- ─── Live updates ──────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.posts, public.likes, public.comments, public.rsvps;
