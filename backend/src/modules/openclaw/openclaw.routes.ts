import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { downloadFile } from "../../lib/storage";
import { loadActiveVersion } from "../../lib/documentVersions";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPdfText } from "../../lib/pdfText";
import { ensureDocAccess } from "../../lib/access";
import {
  createOpenClawTask,
  buildOpenClawTaskSystemPrompt,
  type OpenClawTaskInput,
} from "../../lib/openclaw/tasks";
import {
  persistTaskRecord,
  updateTaskStatus,
  recordAuditEvent,
  defaultApprovalStatus,
  type ApprovalStatus,
} from "../../lib/openclaw/audit";
import { checkOpenClawHealth } from "../../lib/openclaw/health";
import {
  streamChatWithTools,
  resolveModel,
  type LlmMessage,
} from "../../lib/llm";

export const openclawRouter = Router();

const DEFAULT_MODEL = "claude-sonnet-5-5";

openclawRouter.get("/status", async (_req, res) => {
  const health = await checkOpenClawHealth();
  res.status(health.ok ? 200 : 503).json(health);
});

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
): Promise<
  | { ok: true; text: string; filename: string | null }
  | { ok: false; status: number; detail: string }
> {
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
    return void res.status(400).json({ detail: "Document text is empty" });
  }

  const taskInput: OpenClawTaskInput = {
    kind: "document_review",
    jurisdiction: body.jurisdiction ?? null,
    practice_area: body.practice_area ?? null,
    input_documents: inputDocumentIds,
    instructions: body.instructions ?? null,
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

  const selectedModel = resolveModel(body.model, DEFAULT_MODEL);
  const systemPrompt = buildOpenClawTaskSystemPrompt(envelope);

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
    documentText.slice(0, 200_000),
    "END DOCUMENT",
  ].join("\n");

  const messages: LlmMessage[] = [{ role: "user", content: userTurn }];

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
      tools: [],
      maxIterations: 1,
      callbacks: {
        onContentDelta: (delta) => write({ type: "content_delta", text: delta }),
        onReasoningDelta: (delta) =>
          write({ type: "reasoning_delta", text: delta }),
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
  eventType: "task.approved" | "task.rejected" | "task.revision_requested",
): Promise<void> {
  const userId = res.locals.userId as string;
  const rawTaskId = req.params.taskId;
  const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
  if (!taskId) {
    return void res.status(400).json({ detail: "Missing taskId" });
  }
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
          "OpenClaw audit tables not installed - apply the openclaw migrations",
      });
    }
    return void res.status(500).json({ detail: error.message });
  }
  if (!data) return void res.status(404).json({ detail: "Task not found" });

  await recordAuditEvent(
    {
      taskId,
      userId,
      type: eventType,
      payload: {
        note: (req.body?.note as string | undefined)?.slice(0, 2000) ?? null,
      },
    },
    db,
  );
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
