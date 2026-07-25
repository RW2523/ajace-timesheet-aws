-- =============================================================================
-- AJACE Timesheet (Direct++) — AWS-native schema for Amazon RDS PostgreSQL.
-- No Supabase: no RLS, no auth.* schema, no PostgREST. Identity lives in
-- auth_users; per-user scoping is enforced in the app (lib/aws/data.js).
-- Apply once:  psql "$DATABASE_URL" -f schema.sql
-- =============================================================================
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------- identity (replaces Supabase auth.users) --------------------------
create table if not exists public.auth_users (
  id             uuid primary key default gen_random_uuid(),
  email          text unique not null,
  password_hash  text not null,
  role           text not null default 'employee' check (role in ('employee','admin')),
  email_verified boolean not null default true,
  reset_token    text,
  reset_expires  timestamptz,
  created_at     timestamptz not null default now()
);

-- ---------- ts_profiles ------------------------------------------------------
create table if not exists public.ts_profiles (
  id            uuid primary key references public.auth_users(id) on delete cascade,
  email         text,
  full_name     text,
  phone         text,
  role          text not null default 'employee' check (role in ('employee','admin')),
  employer      text,
  client        text,
  job_title     text,
  employee_code text,
  country       text default 'US',
  manager_name  text,
  manager_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- ts_files ---------------------------------------------------------
create table if not exists public.ts_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.auth_users(id) on delete cascade,
  month        int  not null check (month between 1 and 12),
  year         int  not null,
  file_name    text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   bigint,
  status       text not null default 'uploaded'
               check (status in ('uploaded','processing','processed','failed')),
  created_at   timestamptz not null default now()
);
create index if not exists ts_files_user_idx on public.ts_files(user_id, year, month);

-- ---------- ts_timesheets ----------------------------------------------------
create table if not exists public.ts_timesheets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.auth_users(id) on delete cascade,
  file_id          uuid references public.ts_files(id) on delete set null,
  month            int  not null check (month between 1 and 12),
  year             int  not null,
  employee_name    text,
  employee_id      text,
  client           text,
  projects         text[],
  monthly_regular  numeric default 0,
  monthly_overtime numeric default 0,
  monthly_total    numeric default 0,
  days_worked      int default 0,
  days             jsonb default '[]'::jsonb,
  questionnaire    jsonb default '{}'::jsonb,
  validation       jsonb default '{}'::jsonb,
  ai_confidence    numeric,
  ai_status        text default 'ok' check (ai_status in ('ok','partial','failed','manual')),
  created_at       timestamptz not null default now(),
  unique (user_id, year, month)
);
create index if not exists ts_timesheets_user_idx on public.ts_timesheets(user_id, year, month);

-- ---------- ts_employee_edits ------------------------------------------------
create table if not exists public.ts_employee_edits (
  id            uuid primary key default gen_random_uuid(),
  timesheet_id  uuid references public.ts_timesheets(id) on delete cascade,
  user_id       uuid not null references public.auth_users(id) on delete cascade,
  month         int not null,
  year          int not null,
  fields        jsonb default '{}'::jsonb,
  days          jsonb default '[]'::jsonb,
  questionnaire jsonb default '{}'::jsonb,
  validation    jsonb default '{}'::jsonb,
  submitted     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists ts_employee_edits_idx on public.ts_employee_edits(user_id, year, month);

-- ---------- ts_admin_edits ---------------------------------------------------
create table if not exists public.ts_admin_edits (
  id               uuid primary key default gen_random_uuid(),
  timesheet_id     uuid references public.ts_timesheets(id) on delete cascade,
  employee_user_id uuid not null references public.auth_users(id) on delete cascade,
  admin_user_id    uuid not null references public.auth_users(id) on delete cascade,
  month            int not null,
  year             int not null,
  fields           jsonb default '{}'::jsonb,
  days             jsonb default '[]'::jsonb,
  questionnaire    jsonb default '{}'::jsonb,
  validation       jsonb default '{}'::jsonb,
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists ts_admin_edits_idx on public.ts_admin_edits(employee_user_id, year, month);

-- ---------- ts_app_settings (seed Direct++) ----------------------------------
create table if not exists public.ts_app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
insert into public.ts_app_settings(key, value) values ('ai_flow','direct_serverless')
  on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------- updated_at touch on ts_profiles ----------------------------------
create or replace function public.ts_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists ts_profiles_touch on public.ts_profiles;
create trigger ts_profiles_touch before update on public.ts_profiles
  for each row execute function public.ts_touch_updated_at();

-- ---------- migrations for already-provisioned databases ---------------------
-- `create table if not exists` above skips existing tables, so schema changes
-- must also be expressed as idempotent ALTERs. Safe to re-run.

-- 'manual' is written by the "Enter manually instead" flow.
alter table public.ts_timesheets drop constraint if exists ts_timesheets_ai_status_check;
alter table public.ts_timesheets add constraint ts_timesheets_ai_status_check
  check (ai_status in ('ok','partial','failed','manual'));
