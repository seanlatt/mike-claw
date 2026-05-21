import { createServerSupabase } from "../supabase";
import type { OpenClawTaskEnvelope } from "./tasks";

// ---------------------------------------------------------------------------
// OpenClaw audit + approval state
// ---------------------------------------------------------------------------
// Persists task envelopes and append-only audit events for each task. All
// writes degrade gracefully (log + continue) when the openclaw_tasks /
// openclaw_audit_events tables are missing — the migration in
// backend/migrations/001_openclaw_audit.sql is optional for v1.
//
// This is intentionally not exception-throwing: an audit-table miss must
// never break a legal review for the end user. The visible audit trail
// becomes "warnings in the backend log" until the schema is applied.

const MISSING_TABLE_CODES = new Set([
    "42P01", // undefined_table
    "PGRST205", // PostgREST: table not found in schema cache
]);

type Db = ReturnType<typeof createServerSupabase>;

export type ApprovalStatus =
    | "draft"
    | "needs_review"
    | "approved"
    | "rejected"
    | "revision_requested";

export type TaskRecord = {
    task_id: string;
    user_id: string;
    project_id?: string | null;
    kind: string;
    jurisdiction?: string | null;
    practice_area?: string | null;
    instructions?: string | null;
    input_documents?: string[];
    model?: string | null;
    provider?: string | null;
    approval_required: boolean;
    status: ApprovalStatus | "running";
    artifact?: unknown;
};

function looksLikeMissingTable(err: { code?: string; message?: string }): boolean {
    if (err.code && MISSING_TABLE_CODES.has(err.code)) return true;
    const msg = err.message || "";
    return /relation \"public\.openclaw_/i.test(msg) ||
        /could not find the table 'public\.openclaw_/i.test(msg);
}

function warnMissingTable(scope: string, err: { code?: string; message?: string }): void {
    console.warn(
        `[openclaw audit] ${scope}: openclaw tables missing — apply backend/migrations/001_openclaw_audit.sql to enable persistent audit (${err.code ?? "no code"}: ${err.message ?? "no message"})`,
    );
}

// ---------------------------------------------------------------------------
// Task creation / update
// ---------------------------------------------------------------------------

export async function persistTaskRecord(
    record: TaskRecord,
    db?: Db,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const row = {
        task_id: record.task_id,
        user_id: record.user_id,
        project_id: record.project_id ?? null,
        kind: record.kind,
        jurisdiction: record.jurisdiction ?? null,
        practice_area: record.practice_area ?? null,
        instructions: record.instructions ?? null,
        input_documents: record.input_documents ?? [],
        model: record.model ?? null,
        provider: record.provider ?? null,
        approval_required: record.approval_required,
        status: record.status,
        artifact: record.artifact ?? null,
        updated_at: new Date().toISOString(),
    };

    const { error } = await client
        .from("openclaw_tasks")
        .upsert(row, { onConflict: "task_id" });

    if (error) {
        if (looksLikeMissingTable(error)) {
            warnMissingTable("persistTaskRecord", error);
            return;
        }
        console.error("[openclaw audit] persistTaskRecord failed:", error);
    }
}

export async function updateTaskStatus(
    taskId: string,
    patch: {
        status?: ApprovalStatus | "running";
        artifact?: unknown;
        model?: string | null;
        provider?: string | null;
    },
    db?: Db,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const row: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.artifact !== undefined) row.artifact = patch.artifact;
    if (patch.model !== undefined) row.model = patch.model;
    if (patch.provider !== undefined) row.provider = patch.provider;

    const { error } = await client
        .from("openclaw_tasks")
        .update(row)
        .eq("task_id", taskId);

    if (error) {
        if (looksLikeMissingTable(error)) {
            warnMissingTable("updateTaskStatus", error);
            return;
        }
        console.error("[openclaw audit] updateTaskStatus failed:", error);
    }
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

export type AuditEventType =
    | "task.created"
    | "task.started"
    | "task.completed"
    | "task.failed"
    | "task.approved"
    | "task.rejected"
    | "task.revision_requested"
    | "tool.invoked"
    | "document.read"
    | "document.edited"
    | "artifact.produced";

export async function recordAuditEvent(
    input: {
        taskId: string;
        userId: string;
        type: AuditEventType;
        payload?: Record<string, unknown>;
    },
    db?: Db,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const { error } = await client.from("openclaw_audit_events").insert({
        task_id: input.taskId,
        user_id: input.userId,
        event_type: input.type,
        payload: input.payload ?? {},
    });
    if (error) {
        if (looksLikeMissingTable(error)) {
            warnMissingTable("recordAuditEvent", error);
            return;
        }
        console.error("[openclaw audit] recordAuditEvent failed:", error);
    }
}

// ---------------------------------------------------------------------------
// Higher-level helper used by the document-review route
// ---------------------------------------------------------------------------

export function defaultApprovalStatus(envelope: OpenClawTaskEnvelope): ApprovalStatus {
    // Anything external-facing (legal output destined for clients, courts,
    // or counterparties) defaults to needs_review per the plan.
    return envelope.approval_required === false ? "draft" : "needs_review";
}
