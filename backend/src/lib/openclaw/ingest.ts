import { createServerSupabase } from "../supabase";
import { downloadFile } from "../storage";
import { loadActiveVersion } from "../documentVersions";
import { extractDocxBodyText } from "../docxTrackedChanges";
import { extractPdfText } from "../chatTools";
import {
    streamChatWithTools,
    DEFAULT_MAIN_MODEL,
    resolveModel,
} from "../llm";
import {
    createOpenClawTask,
    buildOpenClawTaskSystemPrompt,
    loadMikeSkillBody,
} from "./tasks";
import {
    persistTaskRecord,
    recordAuditEvent,
    updateTaskStatus,
} from "./audit";
import { ensureMatterWiki, indexMatter } from "../wiki/store";
import { MIKE_WIKI_TOOLS } from "./wikiTools";

// ---------------------------------------------------------------------------
// Background ingest — invoked fire-and-forget from /openclaw/intake.
//
// Goal: by the time the lawyer lands on the project page (typically 3-5s
// after the intake response), the matter wiki is already populated:
// parties.md, timeline.md, obligations.md, risks.md, definitions.md,
// open-questions.md all reflect what the document actually says, and
// sources/doc-<id>.md has the per-document summary.
//
// Why background? The intake HTTP response shouldn't block on a 20-30s
// agent turn. The lawyer gets the project page immediately; the wiki
// fills in shortly after. If they query before ingest completes, the
// matter context augmentation in chatTools.ts handles the on-the-fly
// case — the agent populates pages it needs but hasn't been pre-built.
//
// Persistence: an openclaw_tasks row with kind=ingest is created so the
// operator can see the work happened (or failed) without watching logs.

export type IngestOptions = {
    projectId: string;
    documentId: string;
    documentFilename: string;
    userId: string;
    matterTitle: string;
    classification: Record<string, unknown> | null;
    model?: string;
};

const INGEST_TEXT_CAP = 100_000;

export function kickoffBackgroundIngest(opts: IngestOptions): void {
    // Fire-and-forget. We deliberately don't await — the caller (intake
    // route) returns its HTTP response immediately. Any failure is
    // captured by the task/audit records and console logs; we never let
    // a thrown error crash the Node process.
    void runIngest(opts).catch((err) => {
        console.error(
            `[ingest] background ingest crashed for matter=${opts.projectId} doc=${opts.documentId}:`,
            err,
        );
    });
}

async function runIngest(opts: IngestOptions): Promise<void> {
    const db = createServerSupabase();
    const selectedModel = resolveModel(opts.model, DEFAULT_MAIN_MODEL);

    // 1. Resolve the document text — same path Mike's chat read_document uses.
    const text = await loadDocumentText(opts.documentId, db);
    if (!text) {
        console.warn(
            `[ingest] no text extractable for matter=${opts.projectId} doc=${opts.documentId}; skipping`,
        );
        return;
    }

    // 2. Build the task envelope + audit row.
    const envelope = createOpenClawTask({
        userId: opts.userId,
        projectId: opts.projectId,
        task: {
            kind: "intake_triage" as const, // reuse enum slot for now; effective behavior driven by instructions
            jurisdiction:
                (opts.classification?.jurisdiction as string | undefined) ?? null,
            practice_area:
                (opts.classification?.practice_area as string | undefined) ??
                null,
            input_documents: [opts.documentId],
            instructions: `Ingest the newly-uploaded document into the matter wiki. Populate aggregates and create sources/doc-${opts.documentId}.md.`,
            approval_required: false,
        },
    });
    if (!envelope) {
        console.warn("[ingest] failed to create task envelope; skipping");
        return;
    }

    await persistTaskRecord(
        {
            task_id: envelope.task_id,
            user_id: opts.userId,
            project_id: opts.projectId,
            kind: "intake_triage",
            jurisdiction: envelope.jurisdiction ?? null,
            practice_area: envelope.practice_area ?? null,
            instructions: envelope.instructions ?? null,
            input_documents: envelope.input_documents ?? [],
            model: selectedModel,
            provider: "openclaw",
            approval_required: false,
            status: "running",
        },
        db,
    );
    await recordAuditEvent(
        {
            taskId: envelope.task_id,
            userId: opts.userId,
            type: "task.started",
            payload: {
                stage: "background_ingest",
                document_id: opts.documentId,
                filename: opts.documentFilename,
                model: selectedModel,
            },
        },
        db,
    );

    // 3. Ensure wiki exists (intake already did this, but be defensive).
    try {
        await ensureMatterWiki(opts.projectId, {
            matterTitle: opts.matterTitle,
            classification: opts.classification,
            firstDocument: {
                id: opts.documentId,
                filename: opts.documentFilename,
            },
        });
    } catch (err) {
        console.warn("[ingest] wiki ensure failed (non-fatal):", err);
    }

    // 4. Gather current wiki state so the agent knows what's already there.
    let pageList = "  (none yet — empty wiki)";
    try {
        const idx = await indexMatter(opts.projectId);
        pageList = idx.pages
            .map((p) => `  - ${p.page}  (${p.chars} B)`)
            .join("\n") || pageList;
    } catch {
        /* ignore */
    }

    // 5. Build the system prompt: mike-legal skill body is the canonical
    // operating manual; we add an ingest-specific context block on top.
    const systemPrompt = [
        loadMikeSkillBody(),
        "",
        "═".repeat(72),
        "",
        "# CLAW-NATIVE INGEST TASK",
        "",
        "You are populating the matter wiki for a newly-uploaded source",
        "document. Follow the **Ingest** operation from the mike-legal skill",
        "exactly. Do NOT answer questions, draft documents, or hold a",
        "conversation — this is a one-shot ingest, not a chat.",
        "",
        "## Matter",
        `- matter_id: ${opts.projectId}`,
        `- name: ${opts.matterTitle}`,
        `- jurisdiction: ${(opts.classification?.jurisdiction as string) ?? "unspecified"}`,
        `- practice_area: ${(opts.classification?.practice_area as string) ?? "unspecified"}`,
        "",
        "## Your user_id for ALL mike_wiki_* tool calls",
        opts.userId,
        "",
        "## Document being ingested",
        `- document_id: ${opts.documentId}`,
        `- filename: ${opts.documentFilename}`,
        "",
        "## Wiki pages already present (read before writing)",
        pageList,
        "",
        "## Required writes (use mike_wiki_write — overwrite if non-skeleton, merge if not)",
        "1. `parties.md` — populate with parties from this document",
        "2. `timeline.md` — populate with key dates/term/notice/renewal",
        "3. `obligations.md` — running register grouped by party",
        "4. `risks.md` — running risk register with severity + rationale",
        "5. `definitions.md` — defined-terms glossary",
        "6. `open-questions.md` — missing facts the lawyer must verify",
        `7. \`sources/doc-${opts.documentId}.md\` — per-document summary with frontmatter \`sources: [${opts.documentId}]\``,
        "8. `mike_wiki_append` to `log.md`: one line summary of the ingest",
        "",
        "## Important",
        "- Every wiki page MUST include YAML frontmatter with a `sources:` list",
        "  of document_ids it draws from.",
        "- Always read the existing page content first (mike_wiki_read) before",
        "  overwriting — preserve anything still relevant.",
        "- When done, produce a 1-2 sentence prose summary of what you ingested.",
        "  This goes nowhere user-visible but helps you self-check.",
        "═".repeat(72),
    ].join("\n");

    // 6. Build the user turn carrying the document text.
    const userTurn = [
        `Ingest the document below into matter ${opts.projectId}.`,
        "",
        "BEGIN DOCUMENT",
        text.slice(0, INGEST_TEXT_CAP),
        "END DOCUMENT",
    ].join("\n");

    // 7. Run the agent. Wiki tools are routed via the gateway plugin by the
    // openclaw adapter's prefix dispatch — they're advertised in the
    // catalog here so the model knows the schemas to emit in the JSON fence.
    try {
        const { fullText } = await streamChatWithTools({
            model: selectedModel,
            systemPrompt,
            messages: [{ role: "user", content: userTurn }],
            tools: MIKE_WIKI_TOOLS,
            maxIterations: 12, // 8 writes + a few re-reads + final
            enableThinking: false,
        });

        await updateTaskStatus(
            envelope.task_id,
            {
                status: "approved",
                artifact: {
                    kind: "ingest",
                    project_id: opts.projectId,
                    document_id: opts.documentId,
                    summary: fullText.slice(0, 2000),
                },
            },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId: opts.userId,
                type: "task.completed",
                payload: {
                    stage: "background_ingest",
                    document_id: opts.documentId,
                },
            },
            db,
        );
        console.log(
            `[ingest] completed matter=${opts.projectId} doc=${opts.documentId} task=${envelope.task_id}`,
        );
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
            `[ingest] failed matter=${opts.projectId} doc=${opts.documentId}: ${detail}`,
        );
        await updateTaskStatus(envelope.task_id, { status: "draft" }, db);
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId: opts.userId,
                type: "task.failed",
                payload: { detail, document_id: opts.documentId },
            },
            db,
        );
    }
}

async function loadDocumentText(
    documentId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<string | null> {
    const { data: doc } = await db
        .from("documents")
        .select("file_type")
        .eq("id", documentId)
        .single();
    if (!doc) return null;
    const active = await loadActiveVersion(documentId, db);
    if (!active) return null;
    const bytes = await downloadFile(active.storage_path);
    if (!bytes) return null;
    const fileType = ((doc.file_type as string | undefined) ?? "").toLowerCase();
    try {
        if (fileType === "docx" || fileType === "doc") {
            return await extractDocxBodyText(Buffer.from(bytes));
        }
        if (fileType === "pdf") {
            return await extractPdfText(bytes);
        }
        return Buffer.from(bytes).toString("utf-8");
    } catch (err) {
        console.error("[ingest] text extract failed:", err);
        return null;
    }
}
