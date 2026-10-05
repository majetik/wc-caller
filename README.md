# WC Caller

A phone-first social feed: posts up to 299 characters with photos, videos and links, likes, comment threads, and meetup invites with Coming / Not RSVPs that open Google Calendar.

Live at https://majetik.github.io/wc-caller/

## How it's built

- **Front end:** plain HTML, CSS and JavaScript (`index.html`, `style.css`, `app.js`), hosted on GitHub Pages. No build step.
- **Back end:** [Supabase](https://supabase.com) handles Google sign-in, the Postgres database, photo/video storage and live updates. The connection settings are in `config.js`.
- **Database:** `supabase/schema.sql` creates the tables, access rules, storage bucket and live updates. `supabase/notifications.sql` adds the notification bell and push subscriptions. Run each once in Supabase → SQL Editor.
- **Push notifications:** `sw.js` (service worker) shows notifications on the phone. `supabase/functions/notify-meetup` is a Supabase Edge Function, called by a Database Webhook on new posts, that sends the pushes. It needs the secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `WEBHOOK_SECRET`.

## Making changes

Edit the files, then commit and push to `main`. GitHub Pages republishes within a minute or two.
