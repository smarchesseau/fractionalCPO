# BD CRM setup — stephaniemarchesseau.com

Private, single-user Business Development CRM at `/admin/bd/`. Not linked
from site navigation. Backend runs on the same Supabase project as
Choup_Assist (`zfesbneifcjbzmgsgdsa`); all CRM tables/functions are isolated
from Choup's schema by the `bd_` prefix, dedicated Edge Functions, and
row-level security scoped to one new Auth user.

## 1. Create the owner's Supabase Auth user

In the Supabase dashboard for project `zfesbneifcjbzmgsgdsa` → Authentication
→ Users → **Add user**:

- Email: `marchesseau.stephanie@gmail.com`
- Set a password (or use "send invite" to set one via email)
- Confirm the email immediately (dashboard has a toggle for this)

This project has public sign-up disabled, so this is the only way to create
the account. `public.bd_is_owner()` and every Edge Function check the JWT's
`email` claim against this exact address — if you ever need a different
owner email, update it in three places: the migration's `bd_is_owner()`
function, `supabase/functions/_shared/auth.ts`, and the `BD_OWNER_EMAIL`
secret.

## 2. Apply the database migration

**Do not use `supabase db push` for this.** This repo's local
`supabase/migrations/` folder only contains the BD CRM's own migration —
it doesn't have Choup_Assist's 17 migrations, even though those are already
applied on the shared remote project. `db push` compares local files
against the remote's applied-migration history and refuses to proceed when
it finds remote versions with no matching local file (that's the
"Remote migration versions not found" error). Its own suggested fix,
`supabase migration repair --status reverted <those versions>`, would mark
Choup's real, currently-applied migrations as "reverted" in the tracking
table — that doesn't touch actual data, but it would confuse any future
`db push` from the Choup_Assist repo into thinking it needs to re-run them.
Since these two repos will always have disjoint local migration folders
against one shared project, this mismatch would resurface on every future
Choup migration too — copying files across is only a one-time patch, not a
real fix.

Instead, apply the migration directly, bypassing CLI migration-history
bookkeeping entirely:

1. Supabase dashboard for project `zfesbneifcjbzmgsgdsa` → **SQL Editor** →
   New query.
2. Paste the full contents of
   `supabase/migrations/20260923000001_bd_crm_schema.sql` and run it.

This creates every `bd_*` table, the `bd_prospect_eligibility` view, RLS
policies, and seeds a single `bd_settings` row. It does not touch any
Choup_Assist table. Use the same SQL Editor approach for any future changes
to the BD CRM schema — keep treating this repo's `supabase/migrations/`
folder as source-of-truth documentation of what's been run, not as
something `supabase db push` will ever apply cleanly against this shared
project.

## 3. Configure secrets and deploy functions

```bash
cp supabase/.env.functions.example supabase/.env.functions.local
# fill in real values in .env.functions.local, then:
supabase secrets set --env-file supabase/.env.functions.local

supabase functions deploy bd-import
supabase functions deploy bd-send-email
supabase functions deploy bd-config-status
# optional:
supabase functions deploy bd-brevo-webhook
```

Keep `BD_REAL_EMAIL_SENDING_ENABLED=false` until you've verified test sends
work end-to-end. Flipping it to `true` is the only thing that allows the
"Confirm and send batch" flow to actually call Brevo for real.

## 4. Get a Brevo API key

Brevo dashboard → SMTP & API → API Keys → create a key with transactional
email send permission. Put it in `BREVO_API_KEY`. Verify or authenticate the
sender domain/address you put in `BREVO_SENDER_EMAIL` in Brevo's Senders
settings, or sends will be rejected.

## 5. Optional: Brevo webhook

Only if you want delivered/opened/clicked/bounced events recorded (this
never infers a reply — replies stay manual):

1. `openssl rand -hex 24` → put the result in `BD_WEBHOOK_SECRET`, re-run
   `supabase secrets set --env-file supabase/.env.functions.local`.
2. Deploy `bd-brevo-webhook` if you haven't already.
3. In Brevo → Transactional → Settings → Webhooks, add:
   `https://zfesbneifcjbzmgsgdsa.functions.supabase.co/bd-brevo-webhook?secret=<the secret>`
   and select delivered/opened/click/hard_bounce/blocked/soft_bounce events.

## 6. Deploy the frontend

Nothing special: `admin/bd/` is plain static HTML/JS, committed alongside
the rest of `fractionalCPO`. GitHub Pages will serve it at
`https://stephaniemarchesseau.com/admin/bd/` the same way it serves every
other folder. It is not linked from any public page and is not listed in
`sitemap.xml` or `robots.txt` (worth double-checking `robots.txt` disallows
`/admin/` if you want to be extra sure it's never crawled).

`admin/bd/js/config.js` contains the Supabase URL and anon key — this is
intentional and safe (see comment in that file); the actual API key and
service-role key never leave Supabase's Edge Function environment.

## 7. First login

Visit `/admin/bd/login.html`, sign in with the Auth user from step 1. The
app shell only renders after confirming a `bd_settings` row is readable
(i.e. RLS accepted you) — anyone else's session gets the "Access denied"
screen instead, even if they somehow authenticate against this Supabase
project through Choup_Assist's own login.

## 8. Running the test suite

```bash
deno test supabase/functions/_shared/
```

Covers email validation, duplicate detection, subject/body parsing,
template rendering and unresolved-variable blocking, follow-up eligibility,
status-based exclusion, and the webhook's timing-safe secret comparison.
Brevo is never called in these tests. (Deno wasn't available in the
environment this was built in — run this yourself before relying on it, the
same caveat that applied to the Sea View Yoga CRM's test suite.)

There is no automated test harness for the frontend or for RLS policies
themselves (same limitation as the reused Sea View Yoga CRM) — verify those
manually: log in as the owner and confirm the dashboard loads; if you can,
try querying a `bd_` table from the Supabase SQL editor as a different
user/anon role and confirm it returns nothing.

## What's deliberately not implemented

- No automatic follow-up scheduling, cron jobs, or reply detection.
- No batch send loop on the server — the browser calls `bd-send-email` once
  per recipient with a 30-90s pause, so sending is inherently manual,
  resumable, and never runs as one long request.
- No multi-user/roles — `bd_is_owner()` hardcodes a single email address.
