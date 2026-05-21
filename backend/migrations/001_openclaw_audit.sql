-- Mike OpenClaw audit + approval state
-- Adds two tables Mike uses to track agentic tasks and their human-review
-- state. Apply on top of 000_one_shot_schema.sql (or any prior schema).
--
-- Tables:
--   openclaw_tasks         one row per OpenClaw task envelope Mike runs
--   openclaw_audit_events  append-only audit log for each task
--
-- Both are RLS-restricted to the task owner.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- openclaw_tasks
-- ---------------------------------------------------------------------------

create table if not exists public.openclaw_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  task_id text not null unique,
  kind text not null,
  jurisdiction text,
  practice_area text,
  instructions text,
  input_documents jsonb not null default '[]'::jsonb,
  model text,
  provider text,
  approval_required boolean not null default true,
  status text not null default 'running',
  artifact jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_openclaw_tasks_user
  on public.openclaw_tasks(user_id, created_at desc);
create index if not exists idx_openclaw_tasks_project
  on public.openclaw_tasks(project_id, created_at desc);
create index if not exists idx_openclaw_tasks_status
  on public.openclaw_tasks(status);

alter table public.openclaw_tasks enable row level security;

drop policy if exists "Users see their own openclaw tasks" on public.openclaw_tasks;
create policy "Users see their own openclaw tasks"
  on public.openclaw_tasks for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert their own openclaw tasks" on public.openclaw_tasks;
create policy "Users insert their own openclaw tasks"
  on public.openclaw_tasks for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update their own openclaw tasks" on public.openclaw_tasks;
create policy "Users update their own openclaw tasks"
  on public.openclaw_tasks for update
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- openclaw_audit_events
-- ---------------------------------------------------------------------------

create table if not exists public.openclaw_audit_events (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_openclaw_audit_task
  on public.openclaw_audit_events(task_id, created_at);
create index if not exists idx_openclaw_audit_user
  on public.openclaw_audit_events(user_id, created_at desc);

alter table public.openclaw_audit_events enable row level security;

drop policy if exists "Users see their own audit events" on public.openclaw_audit_events;
create policy "Users see their own audit events"
  on public.openclaw_audit_events for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert their own audit events" on public.openclaw_audit_events;
create policy "Users insert their own audit events"
  on public.openclaw_audit_events for insert
  with check (auth.uid() = user_id);
