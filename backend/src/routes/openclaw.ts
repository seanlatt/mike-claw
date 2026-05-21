import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { extractPdfText } from "../lib/chatTools";
import { ensureDocAccess } from "../lib/access";
import {
    createOpenClawTask,
    buildOpenClawTaskSystemPrompt,
    type OpenClawTaskInput,
} from "../lib/openclaw/tasks";
import {
    persistTaskRecord,
    updateTaskStatus,
    recordAuditEvent,
    defaultApprovalStatus,
    type ApprovalStatus,
} from "../lib/openclaw/audit";
import { checkOpenClawHealth } from "../lib/openclaw/health";
import {
    streamChatWithTools,
    resolveModel,
    DEFAULT_MAIN_MODEL,
    type LlmMessage,
} from "../lib/llm";

// ---------------------------------------------------------------------------
// Mike's claw-native task router
// ---------------------------------------------------------------------------
// This is the first explicit OpenClaw workflow: document_review.
//
// The existing chat/* and projects/*/chat routes keep working unchanged —
// they speak Mike's chat vocabulary. This router speaks OpenClaw's task
// vocabulary: a structured envelope (kind, jurisdiction, practice_area,
// input_documents, approval_required) gets wrapped around the LLM call,
// the system prompt is generated from the envelope, and every run is
// persisted as an openclaw_tasks row + openclaw_audit_events trail.
//
// Routes:
//   GET  /openclaw/status                  health probe (no auth)
//   POST /openclaw/document-review         run a document-review task (SSE)
//   GET  /openclaw/tasks                   list this user's recent tasks
//   POST /openclaw/tasks/:taskId/approve   move task -> approved
//   POST /openclaw/tasks/:taskId/reject    move task -> rejected
//   POST /openclaw/tasks/:taskId/revise    move task -> revision_requested

export const openclawRouter = Router();

// ---------------------------------------------------------------------------
// Health probe — exposed without auth so the UI can render connection state
// without forcing a logged-in user. Returns the same shape as the main
// /health/openclaw endpoint mounted in index.ts.
// ---------------------------------------------------------------------------

openclawRouter.get("/status", async (_req, res) => {
    const health = await checkOpenClawHealth();
    res.status(health.ok ? 200 : 503).json(health);
});

// ---------------------------------------------------------------------------
// POST /openclaw/document-review
// ---------------------------------------------------------------------------

type DocumentReviewBody = {
    project_id?: string | null;
    document_id?: string | null;
    pasted_text?: string | null;
    jurisdiction?: string | null;
    practice_area?: string | null;
    instructions?: string | null;
    approval_required?: boolean;
    model?: string | null;
};

async function loadDocumentText(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ ok: true; text: string; filename: string | null } | { ok: false; status: number; detail: string }> {
    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, filename, file_type")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false, status: 404, detail: "Document not found" };

    const access = await ensureDocAccess(
        {
            user_id: doc.user_id as string,
            project_id: (doc.project_id as string | null) ?? null,
        },
        userId,
        userEmail,
        db,
    );
    if (!access.ok) {
        return { ok: false, status: 404, detail: "Document not found" };
    }

    const active = await loadActiveVersion(documentId, db);
    if (!active) {
        return { ok: false, status: 404, detail: "Document has no active version" };
    }
    const bytes = await downloadFile(active.storage_path);
    if (!bytes) {
        return {
            ok: false,
            status: 500,
            detail: "Document storage unreachable",
        };
    }

    const fileType = (doc.file_type as string | undefined)?.toLowerCase() ?? "";
    try {
        if (fileType === "docx" || fileType === "doc") {
            const text = await extractDocxBodyText(Buffer.from(bytes));
            return { ok: true, text, filename: (doc.filename as string) ?? null };
        }
        if (fileType === "pdf") {
            const text = await extractPdfText(bytes);
            return { ok: true, text, filename: (doc.filename as string) ?? null };
        }
        // Unknown type — best-effort utf-8 decode.
        const text = Buffer.from(bytes).toString("utf-8");
        return { ok: true, text, filename: (doc.filename as string) ?? null };
    } catch (err) {
        console.error("[openclaw/document-review] text extraction failed:", err);
        return {
            ok: false,
            status: 500,
            detail: "Failed to extract document text",
        };
    }
}

openclawRouter.post("/document-review", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const body = (req.body ?? {}) as DocumentReviewBody;

    if (!body.document_id && !body.pasted_text?.trim()) {
        return void res
            .status(400)
            .json({ detail: "Provide document_id or pasted_text" });
    }

    const db = createServerSupabase();

    // Resolve document text (or use pasted text).
    let documentText = body.pasted_text?.trim() ?? "";
    let documentFilename: string | null = null;
    const inputDocumentIds: string[] = [];
    if (body.document_id) {
        const loaded = await loadDocumentText(
            body.document_id,
            userId,
            userEmail,
            db,
        );
        if (!loaded.ok) {
            return void res.status(loaded.status).json({ detail: loaded.detail });
        }
        documentText = loaded.text;
        documentFilename = loaded.filename;
        inputDocumentIds.push(body.document_id);
    }

    if (!documentText.trim()) {
        return void res
            .status(400)
            .json({ detail: "Document text is empty" });
    }

    const taskInput: OpenClawTaskInput = {
        kind: "document_review",
        jurisdiction: body.jurisdiction ?? null,
        practice_area: body.practice_area ?? null,
        input_documents: inputDocumentIds,
        instructions: body.instructions ?? null,
        // External-facing legal review defaults to needs_review.
        approval_required: body.approval_required ?? true,
    };
    const envelope = createOpenClawTask({
        userId,
        projectId: body.project_id ?? null,
        task: taskInput,
    });
    if (!envelope) {
        return void res
            .status(500)
            .json({ detail: "Failed to create OpenClaw task envelope" });
    }

    const selectedModel = resolveModel(body.model, DEFAULT_MAIN_MODEL);
    const systemPrompt = buildOpenClawTaskSystemPrompt(envelope);

    // The user-facing turn carries the document text. We keep it short and
    // explicit so the model knows what to do.
    const userTurn = [
        documentFilename
            ? `Source document: ${documentFilename}`
            : "Source document: (pasted text)",
        "",
        body.instructions
            ? `Reviewer instructions: ${body.instructions}`
            : "Reviewer instructions: produce the structured legal review described in the system prompt.",
        "",
        "BEGIN DOCUMENT",
        documentText.slice(0, 200_000), // cap to keep prompts predictable
        "END DOCUMENT",
    ].join("\n");

    const messages: LlmMessage[] = [
        { role: "user", content: userTurn },
    ];

    // Persist the task envelope before we run so the audit trail records
    // even a failed run.
    await persistTaskRecord(
        {
            task_id: envelope.task_id,
            user_id: userId,
            project_id: envelope.project_id ?? null,
            kind: envelope.kind,
            jurisdiction: envelope.jurisdiction ?? null,
            practice_area: envelope.practice_area ?? null,
            instructions: envelope.instructions ?? null,
            input_documents: envelope.input_documents ?? [],
            model: selectedModel,
            provider: null,
            approval_required: envelope.approval_required !== false,
            status: "running",
        },
        db,
    );
    await recordAuditEvent(
        {
            taskId: envelope.task_id,
            userId,
            type: "task.created",
            payload: {
                kind: envelope.kind,
                model: selectedModel,
                input_documents: envelope.input_documents,
                jurisdiction: envelope.jurisdiction,
                practice_area: envelope.practice_area,
            },
        },
        db,
    );

    // SSE response. Matches the shape Mike's existing chat code uses
    // (data: {...}\n\n) so the frontend stream parser stays unchanged.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (event: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    write({
        type: "task_started",
        task_id: envelope.task_id,
        kind: envelope.kind,
        model: selectedModel,
        approval_required: envelope.approval_required !== false,
    });
    await recordAuditEvent(
        {
            taskId: envelope.task_id,
            userId,
            type: "task.started",
            payload: { model: selectedModel },
        },
        db,
    );

    try {
        const { fullText } = await streamChatWithTools({
            model: selectedModel,
            systemPrompt,
            messages,
            // Document review does not invoke Mike's edit tools — that's
            // a separate workflow. Keep this run tool-free so the OpenClaw
            // gateway (which doesn't drive Mike tools yet) is fine.
            tools: [],
            maxIterations: 1,
            callbacks: {
                onContentDelta: (delta) => write({ type: "content_delta", text: delta }),
                onReasoningDelta: (delta) => write({ type: "reasoning_delta", text: delta }),
                onReasoningBlockEnd: () => write({ type: "reasoning_block_end" }),
            },
        });

        const approval: ApprovalStatus = defaultApprovalStatus(envelope);
        const artifact = {
            kind: envelope.kind,
            text: fullText,
            input_documents: envelope.input_documents ?? [],
            jurisdiction: envelope.jurisdiction ?? null,
            practice_area: envelope.practice_area ?? null,
        };

        await updateTaskStatus(
            envelope.task_id,
            { status: approval, artifact },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "artifact.produced",
                payload: { chars: fullText.length },
            },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "task.completed",
                payload: { approval_status: approval },
            },
            db,
        );

        write({
            type: "task_completed",
            task_id: envelope.task_id,
            approval_status: approval,
        });
        write({ type: "done" });
        res.end();
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[openclaw/document-review] run failed:", err);
        await updateTaskStatus(envelope.task_id, { status: "draft" }, db);
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "task.failed",
                payload: { detail },
            },
            db,
        );
        try {
            write({ type: "error", message: detail.slice(0, 500) });
            write({ type: "done" });
        } catch {
            /* socket may already be closed */
        }
        res.end();
    }
});

// ---------------------------------------------------------------------------
// Task list + approval transitions
// ---------------------------------------------------------------------------

openclawRouter.get("/tasks", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("openclaw_tasks")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
    if (error) {
        // Tolerate missing audit table — return empty list.
        if (
            error.code === "42P01" ||
            error.code === "PGRST205" ||
            /openclaw_tasks/.test(error.message ?? "")
        ) {
            return void res.json([]);
        }
        return void res.status(500).json({ detail: error.message });
    }
    res.json(data ?? []);
});

async function transitionTask(
    req: import("express").Request,
    res: import("express").Response,
    nextStatus: ApprovalStatus,
    eventType:
        | "task.approved"
        | "task.rejected"
        | "task.revision_requested",
): Promise<void> {
    const userId = res.locals.userId as string;
    const taskId = req.params.taskId;
    const db = createServerSupabase();

    const { data, error } = await db
        .from("openclaw_tasks")
        .update({
            status: nextStatus,
            updated_at: new Date().toISOString(),
        })
        .eq("task_id", taskId)
        .eq("user_id", userId)
        .select("*")
        .single();
    if (error) {
        if (
            error.code === "42P01" ||
            error.code === "PGRST205" ||
            /openclaw_tasks/.test(error.message ?? "")
        ) {
            return void res.status(503).json({
                detail:
                    "OpenClaw audit tables not installed — apply backend/migrations/001_openclaw_audit.sql",
            });
        }
        return void res.status(500).json({ detail: error.message });
    }
    if (!data) return void res.status(404).json({ detail: "Task not found" });

    await recordAuditEvent({
        taskId,
        userId,
        type: eventType,
        payload: {
            note: (req.body?.note as string | undefined)?.slice(0, 2000) ?? null,
        },
    }, db);
    res.json(data);
}

openclawRouter.post("/tasks/:taskId/approve", requireAuth, (req, res) => {
    void transitionTask(req, res, "approved", "task.approved");
});
openclawRouter.post("/tasks/:taskId/reject", requireAuth, (req, res) => {
    void transitionTask(req, res, "rejected", "task.rejected");
});
openclawRouter.post("/tasks/:taskId/revise", requireAuth, (req, res) => {
    void transitionTask(req, res, "revision_requested", "task.revision_requested");
});
