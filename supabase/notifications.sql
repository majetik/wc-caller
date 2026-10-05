-- WC Caller: notifications (run once, after schema.sql).
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.

-- ─── In-app notifications (the bell) ───────────────────────────────────────

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,  -- who receives it
  actor_id uuid references public.profiles (id) on delete cascade,          -- who caused it
  post_id bigint references public.posts (id) on delete cascade,
  kind text not null check (kind in ('meetup')),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
create policy "read own notifications" on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy "mark own notifications read" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- When someone posts a meetup, every other member gets a notification.
create function public.notify_new_meetup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.meetup_start is not null then
    insert into public.notifications (user_id, actor_id, post_id, kind)
    select p.id, new.author_id, new.id, 'meetup'
    from public.profiles p
    where p.id <> new.author_id;
  end if;
  return new;
end;
$$;

create trigger on_meetup_posted
  after insert on public.posts
  for each row execute function public.notify_new_meetup();

-- ─── Phone push subscriptions ──────────────────────────────────────────────
-- One row per phone/browser that has allowed notifications.

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  time_zone text,   -- so meetup times in the notification match the reader's clock
  locale text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
create policy "see own subscriptions" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "add own subscriptions" on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid());
create policy "update own subscriptions" on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own subscriptions" on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- ─── Live updates for the bell ─────────────────────────────────────────────

alter publication supabase_realtime add table public.notifications;
