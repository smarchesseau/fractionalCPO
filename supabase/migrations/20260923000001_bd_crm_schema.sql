-- Business Development CRM schema for stephaniemarchesseau.com
-- Single-admin, manual-outreach CRM. Tables are prefixed bd_ to avoid any
-- collision with this Supabase project's other application(s).
--
-- Access model: one dedicated Supabase Auth user (the site owner). RLS on
-- every bd_ table is gated by public.bd_is_owner(), which checks the JWT
-- email claim against a fixed address. There is no admin/role table and no
-- multi-tenant concept by design.

-- ---------------------------------------------------------------------
-- 1. Owner check
-- ---------------------------------------------------------------------
create or replace function public.bd_is_owner()
returns boolean
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'marchesseau.stephanie@gmail.com';
$$;

-- ---------------------------------------------------------------------
-- 2. updated_at trigger helper (generic, reused across bd_ tables)
-- ---------------------------------------------------------------------
create or replace function public.bd_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. bd_settings (singleton row)
-- ---------------------------------------------------------------------
create table public.bd_settings (
  id uuid primary key default '00000000-0000-0000-0000-0000000000b1'::uuid
    check (id = '00000000-0000-0000-0000-0000000000b1'::uuid),
  follow_up_1_min_days integer not null default 4,
  follow_up_2_min_days_after_fu1 integer not null default 4,
  follow_up_2_min_days_after_initial integer not null default 9,
  daily_send_limit integer not null default 200,
  default_test_recipient text,
  default_signature text,
  reply_to_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.bd_settings (id, default_test_recipient, reply_to_email)
values (
  '00000000-0000-0000-0000-0000000000b1'::uuid,
  'marchesseau.stephanie@gmail.com',
  'marchesseau.stephanie@gmail.com'
);

create trigger bd_settings_touch
  before update on public.bd_settings
  for each row execute function public.bd_touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. bd_prospects
-- ---------------------------------------------------------------------
create table public.bd_prospects (
  id uuid primary key default gen_random_uuid(),

  company text not null,
  contact_name text,
  email text not null,
  email_normalized text not null,
  location text,
  employee_range text,
  size_confidence text,
  sector text,
  target_decision_maker text,
  priority text,
  email_verification text,
  source_url text,
  pain_points text,
  automation_opportunities text,

  initial_subject text,
  initial_body text,
  followup1_subject text,
  followup1_body text,
  followup2_subject text,
  followup2_body text,

  -- 'approved' is tracked only via the approved boolean below, not as a
  -- status; 'needs_review' and the three 'ready_for_*' values were never
  -- set by any code path (eligibility is computed live in
  -- bd_prospect_eligibility instead of stored as a status) and were
  -- dropped for the same reason.
  status text not null default 'new' check (status in (
    'new', 'initial_sent', 'followup1_sent', 'followup2_sent',
    'replied', 'interested', 'meeting_booked', 'proposal_sent', 'won',
    'not_interested', 'invalid_email', 'bounced', 'do_not_contact', 'closed'
  )),
  approved boolean not null default false,
  do_not_contact boolean not null default false,
  notes text,

  initial_accepted boolean not null default false,
  followup1_accepted boolean not null default false,
  followup2_accepted boolean not null default false,
  initial_message_id text,
  followup1_message_id text,
  followup2_message_id text,
  initial_send_error text,
  followup1_send_error text,
  followup2_send_error text,

  initial_sent_at timestamptz,
  followup1_sent_at timestamptz,
  followup2_sent_at timestamptz,
  last_contacted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index bd_prospects_email_normalized_idx on public.bd_prospects (email_normalized);
create index bd_prospects_status_idx on public.bd_prospects (status);
create index bd_prospects_approved_idx on public.bd_prospects (approved);
create index bd_prospects_do_not_contact_idx on public.bd_prospects (do_not_contact);

create or replace function public.bd_prospects_normalize()
returns trigger
language plpgsql
as $$
begin
  new.email = btrim(new.email);
  new.email_normalized = lower(btrim(new.email));
  new.updated_at = now();
  return new;
end;
$$;

create trigger bd_prospects_normalize_trg
  before insert or update on public.bd_prospects
  for each row execute function public.bd_prospects_normalize();

-- Log every status change automatically, so the activity trail can't be
-- bypassed by a direct UPDATE from the admin UI.
create or replace function public.bd_prospects_log_status_change()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    insert into public.bd_activity (action, prospect_id, details)
    values ('status_change', new.id, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if (tg_op = 'UPDATE' and new.do_not_contact is distinct from old.do_not_contact) then
    insert into public.bd_activity (action, prospect_id, details)
    values ('do_not_contact_change', new.id, jsonb_build_object('do_not_contact', new.do_not_contact));
  end if;
  if (tg_op = 'UPDATE' and new.approved is distinct from old.approved and new.approved = true) then
    insert into public.bd_activity (action, prospect_id, details) values ('approved', new.id, '{}'::jsonb);
  end if;
  if (tg_op = 'INSERT') then
    insert into public.bd_activity (action, prospect_id, details) values ('prospect_created', new.id, '{}'::jsonb);
  end if;
  return new;
end;
$$;

create trigger bd_prospects_log_trg
  after insert or update on public.bd_prospects
  for each row execute function public.bd_prospects_log_status_change();

-- ---------------------------------------------------------------------
-- 5. bd_batches
-- ---------------------------------------------------------------------
create table public.bd_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email_type text not null check (email_type in ('initial', 'followup1', 'followup2')),
  created_at timestamptz not null default now(),
  created_by text not null default 'marchesseau.stephanie@gmail.com',
  draft boolean not null default true,
  test_sent boolean not null default false,
  sending boolean not null default false,
  completed boolean not null default false,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  current_position integer not null default 0,
  stopped_reason text,
  updated_at timestamptz not null default now()
);

create trigger bd_batches_touch
  before update on public.bd_batches
  for each row execute function public.bd_touch_updated_at();

-- ---------------------------------------------------------------------
-- 6. bd_batch_members
-- ---------------------------------------------------------------------
create table public.bd_batch_members (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.bd_batches(id) on delete cascade,
  prospect_id uuid not null references public.bd_prospects(id) on delete cascade,
  position integer not null default 0,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  message_id text,
  error text,
  attempted_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, prospect_id)
);

create index bd_batch_members_batch_idx on public.bd_batch_members (batch_id);
create index bd_batch_members_status_idx on public.bd_batch_members (batch_id, status);

-- ---------------------------------------------------------------------
-- 7. bd_activity
-- ---------------------------------------------------------------------
create table public.bd_activity (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor text not null default 'marchesseau.stephanie@gmail.com',
  action text not null,
  prospect_id uuid references public.bd_prospects(id) on delete set null,
  batch_id uuid references public.bd_batches(id) on delete set null,
  details jsonb not null default '{}'::jsonb
);

create index bd_activity_occurred_idx on public.bd_activity (occurred_at desc);
create index bd_activity_prospect_idx on public.bd_activity (prospect_id);
create index bd_activity_batch_idx on public.bd_activity (batch_id);

-- ---------------------------------------------------------------------
-- 8. bd_email_events (optional Brevo webhook)
-- ---------------------------------------------------------------------
create table public.bd_email_events (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references public.bd_prospects(id) on delete set null,
  batch_member_id uuid references public.bd_batch_members(id) on delete set null,
  message_id text,
  event_type text not null,
  event_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index bd_email_events_dedupe_idx
  on public.bd_email_events (message_id, event_type, event_at);

-- ---------------------------------------------------------------------
-- 9. Eligibility view
-- ---------------------------------------------------------------------
-- Statuses that remove a prospect from all future follow-up eligibility.
-- security_invoker is required here: without it, a view runs RLS checks as
-- the view's OWNER (not the querying user), which would silently bypass
-- the bd_is_owner() policies on bd_prospects for any authenticated caller.
create or replace view public.bd_prospect_eligibility
with (security_invoker = true)
as
select
  p.*,
  (p.status not in (
    'replied', 'interested', 'meeting_booked', 'proposal_sent', 'won',
    'not_interested', 'do_not_contact', 'closed', 'bounced', 'invalid_email'
  )) as follow_up_allowed_by_status,
  (p.initial_accepted
    and p.followup1_sent_at is null
    and coalesce(p.followup1_body, '') <> ''
    and p.do_not_contact = false
    and p.status not in (
      'replied', 'interested', 'meeting_booked', 'proposal_sent', 'won',
      'not_interested', 'do_not_contact', 'closed', 'bounced', 'invalid_email'
    )
  ) as fu1_eligible,
  (p.followup1_accepted
    and p.followup2_sent_at is null
    and coalesce(p.followup2_body, '') <> ''
    and p.do_not_contact = false
    and p.status not in (
      'replied', 'interested', 'meeting_booked', 'proposal_sent', 'won',
      'not_interested', 'do_not_contact', 'closed', 'bounced', 'invalid_email'
    )
  ) as fu2_eligible,
  extract(day from (now() - p.initial_sent_at))::integer as days_since_initial,
  extract(day from (now() - p.followup1_sent_at))::integer as days_since_followup1,
  (p.initial_sent_at::date + (select follow_up_1_min_days from public.bd_settings limit 1)) as fu1_recommended_date,
  greatest(
    (p.followup1_sent_at::date + (select follow_up_2_min_days_after_fu1 from public.bd_settings limit 1)),
    (p.initial_sent_at::date + (select follow_up_2_min_days_after_initial from public.bd_settings limit 1))
  ) as fu2_recommended_date
from public.bd_prospects p;

-- ---------------------------------------------------------------------
-- 10. Row level security
-- ---------------------------------------------------------------------
alter table public.bd_settings enable row level security;
alter table public.bd_prospects enable row level security;
alter table public.bd_batches enable row level security;
alter table public.bd_batch_members enable row level security;
alter table public.bd_activity enable row level security;
alter table public.bd_email_events enable row level security;

create policy bd_settings_owner on public.bd_settings
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());
create policy bd_prospects_owner on public.bd_prospects
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());
create policy bd_batches_owner on public.bd_batches
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());
create policy bd_batch_members_owner on public.bd_batch_members
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());
create policy bd_activity_owner on public.bd_activity
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());
create policy bd_email_events_owner on public.bd_email_events
  for all to authenticated using (public.bd_is_owner()) with check (public.bd_is_owner());

-- bd_prospect_eligibility (defined above with security_invoker = true)
-- inherits RLS from bd_prospects and bd_settings at query time; it needs no
-- separate policy of its own.

-- ---------------------------------------------------------------------
-- 11. Table-level grants
-- ---------------------------------------------------------------------
-- This project does not rely on Postgres default privileges for new
-- tables (Choup_Assist's own schema grants these explicitly for the same
-- reason) -- without this, "authenticated" has zero privileges on any
-- bd_ table and every query fails with a permission error regardless of
-- RLS or bd_is_owner().
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on
  public.bd_settings,
  public.bd_prospects,
  public.bd_batches,
  public.bd_batch_members,
  public.bd_activity,
  public.bd_email_events
  to authenticated, service_role;
grant select on public.bd_prospect_eligibility to authenticated, service_role;
