-- OpenClaw audit tables
-- Creates the openclaw_tasks and openclaw_audit_events tables for
-- task lifecycle tracking and audit logging.

-- Note: These tables are optional for basic OpenClaw operation. The backend
-- degrades gracefully (logs a warning and continues) if they're missing.
-- Apply this migration to enable persistent audit and approval workflows.

-- Tasks table: stores task envelopes and their approval state.
create table if not exists public.openclaw_tasks (
    task_id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    project_id uuid references public.projects(id) on delete set null,

    kind text not null,
    jurisdiction text,
    practice_area text,
    instructions text,
    input_documents uuid[] default '{}',

    model text,
    provider text,

    approval_required boolean not null default true,
    status text not null default 'draft'
        check (status in ('draft', 'needs_review', 'approved', 'rejected', 'revision_requested', 'running')),

    artifact jsonb,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

comment on table public.openclaw_tasks is
    'OpenClaw task envelopes with approval state';

create index if not exists idx_openclaw_tasks_user_id on public.openclaw_tasks(user_id);
create index if not exists idx_openclaw_tasks_project_id on public.openclaw_tasks(project_id);
create index if not exists idx_openclaw_tasks_status on public.openclaw_tasks(status);
create index if not exists idx_openclaw_tasks_created_at on public.openclaw_tasks(created_at desc);

-- Audit events table: append-only log of task lifecycle events.
create table if not exists public.openclaw_audit_events (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.openclaw_tasks(task_id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,

    event_type text not null
        check (event_type in (
            'task.created', 'task.started', 'task.completed', 'task.failed',
            'task.approved', 'task.rejected', 'task.revision_requested',
            'tool.invoked', 'document.read', 'document.edited', 'artifact.produced'
        )),
    payload jsonb not null default '{}',

    created_at timestamptz not null default now()
);

comment on table public.openclaw_audit_events is
    'Append-only audit log for OpenClaw task lifecycle events';

create index if not exists idx_openclaw_audit_events_task_id on public.openclaw_audit_events(task_id);
create index if not exists idx_openclaw_audit_events_user_id on public.openclaw_audit_events(user_id);
create index if not exists idx_openclaw_audit_events_created_at on public.openclaw_audit_events(created_at desc);

-- Enable RLS (row level security)
alter table public.openclaw_tasks enable row level security;
alter table public.openclaw_audit_events enable row level security;

-- Users can only access their own tasks
create policy "Users can view their own tasks"
    on public.openclaw_tasks for select
    using (auth.uid() = user_id);

create policy "Users can insert their own tasks"
    on public.openclaw_tasks for insert
    with check (auth.uid() = user_id);

create policy "Users can update their own tasks"
    on public.openclaw_tasks for update
    using (auth.uid() = user_id);

-- Users can only access audit events for their own tasks
create policy "Users can view audit events for their tasks"
    on public.openclaw_audit_events for select
    using (auth.uid() = user_id);

create policy "Users can insert audit events for their tasks"
    on public.openclaw_audit_events for insert
    with check (auth.uid() = user_id);
