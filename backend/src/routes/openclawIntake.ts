import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { singleFileUpload } from "../lib/upload";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { extractPdfText } from "../lib/chatTools";
import { saveUploadedDocument } from "./projects";
import {
    buildOpenClawTaskSystemPrompt,
    createOpenClawTask,
} from "../lib/openclaw/tasks";
import {
    persistTaskRecord,
    recordAuditEvent,
    updateTaskStatus,
} from "../lib/openclaw/audit";
import { ensureMatterWiki } from "../lib/wiki/store";
import { kickoffBackgroundIngest } from "../lib/openclaw/ingest";
import {
    streamChatWithTools,
    DEFAULT_MAIN_MODEL,
    resolveModel,
} from "../lib/llm";

// ---------------------------------------------------------------------------
// POST /openclaw/intake
// ---------------------------------------------------------------------------
// One upload → fully-organised matter.
//
//   1. Multer parses the file into memory.
//   2. We extract text (DOCX/PDF) so we can show it to the model.
//   3. OpenClaw runs an `intake_triage` task — the mike-legal skill
//      template asks for strict JSON: matter_title, document_type,
//      jurisdiction, practice_area, parties[], summary,
//      suggested_next_actions[].
//   4. We create a Mike project with the suggested matter_title.
//   5. We save the uploaded file under that project via the existing
//      saveUploadedDocument helper.
//   6. We persist a `task.created` + `task.completed` audit trail for
//      the intake task itself, so the operator can see the lineage.
//   7. We return { project_id, document_id, classification } so the
//      frontend can navigate the user straight into the new matter.
//
// No external sends. The classification is metadata only — humans
// confirm with the project page they land on.

export const openclawIntakeRouter = Router();

const TRIAGE_CHAR_CAP = 60_000;

type ClassificationResult = {
    matter_title: string;
    document_type?: string;
    jurisdiction?: string;
    practice_area?: string;
    parties?: string[];
    summary?: string;
    suggested_next_actions?: string[];
};

function extractJsonObject(raw: string): ClassificationResult | null {
    // Trim model decoration around the JSON (fences, prose). The skill
    // says "JSON only" but we forgive small slips.
    let txt = raw.trim();
    // Strip ```json ... ``` fences if present.
    const fenced = txt.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
    if (fenced && fenced[1]) txt = fenced[1].trim();
    // Otherwise locate the first `{` and matching close.
    const firstBrace = txt.indexOf("{");
    if (firstBrace > 0) txt = txt.slice(firstBrace);
    const lastBrace = txt.lastIndexOf("}");
    if (lastBrace > 0 && lastBrace < txt.length - 1) {
        txt = txt.slice(0, lastBrace + 1);
    }
    try {
        const parsed = JSON.parse(txt) as ClassificationResult;
        if (parsed && typeof parsed.matter_title === "string") return parsed;
        return null;
    } catch {
        return null;
    }
}

function fallbackMatterTitle(filename: string): string {
    const stem = filename.includes(".")
        ? filename.slice(0, filename.lastIndexOf("."))
        : filename;
    return stem.slice(0, 60) || "Untitled matter";
}

openclawIntakeRouter.post(
    "/",
    requireAuth,
    singleFileUpload("file"),
    async (req, res) => {
        const userId = res.locals.userId as string;
        const file = req.file;
        if (!file) {
            return void res.status(400).json({ detail: "file is required" });
        }

        const filename = file.originalname;
        const suffix = filename.includes(".")
            ? filename.split(".").pop()!.toLowerCase()
            : "";
        if (!["pdf", "docx", "doc"].includes(suffix)) {
            return void res.status(400).json({
                detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
            });
        }

        // 1. Extract text directly from the upload buffer for triage.
        const bytes = file.buffer.buffer.slice(
            file.buffer.byteOffset,
            file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer;
        let extractedText = "";
        try {
            if (suffix === "pdf") {
                extractedText = await extractPdfText(bytes);
            } else {
                extractedText = await extractDocxBodyText(file.buffer);
            }
        } catch (err) {
            console.error("[openclaw/intake] text extract failed", err);
            return void res
                .status(500)
                .json({ detail: "Failed to read document text" });
        }
        if (!extractedText.trim()) {
            return void res
                .status(400)
                .json({ detail: "Document appears empty or unparseable" });
        }

        // 2. Build the triage task envelope + prompt.
        const envelope = createOpenClawTask({
            userId,
            projectId: null,
            task: {
                kind: "intake_triage",
                approval_required: false,
                instructions: `Classify this uploaded document so Mike can auto-organize it. Filename: ${filename}.`,
            },
        });
        if (!envelope) {
            return void res
                .status(500)
                .json({ detail: "Failed to create intake task envelope" });
        }

        const db = createServerSupabase();
        const selectedModel = resolveModel(
            (req.body?.model as string | undefined) ?? null,
            DEFAULT_MAIN_MODEL,
        );

        await persistTaskRecord(
            {
                task_id: envelope.task_id,
                user_id: userId,
                project_id: null,
                kind: envelope.kind,
                instructions: envelope.instructions ?? null,
                input_documents: [],
                model: selectedModel,
                provider: null,
                approval_required: false,
                status: "running",
            },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "task.created",
                payload: { kind: envelope.kind, filename, model: selectedModel },
            },
            db,
        );

        // 3. Call OpenClaw — no tools, no streaming surface; we just want
        // the JSON back.
        const triagePromptText = [
            `Filename: ${filename}`,
            "",
            "BEGIN DOCUMENT",
            extractedText.slice(0, TRIAGE_CHAR_CAP),
            "END DOCUMENT",
        ].join("\n");

        let classification: ClassificationResult | null = null;
        try {
            const { fullText } = await streamChatWithTools({
                model: selectedModel,
                systemPrompt: buildOpenClawTaskSystemPrompt(envelope),
                messages: [{ role: "user", content: triagePromptText }],
                tools: [],
                maxIterations: 1,
                enableThinking: false,
            });
            classification = extractJsonObject(fullText);
            if (!classification) {
                console.warn(
                    "[openclaw/intake] model returned non-JSON; using filename fallback",
                    fullText.slice(0, 300),
                );
            }
        } catch (err) {
            console.error("[openclaw/intake] OpenClaw call failed", err);
            // Continue with filename fallback so the upload still works.
        }

        const matterTitle =
            classification?.matter_title?.trim() ||
            fallbackMatterTitle(filename);
        const jurisdiction =
            classification?.jurisdiction?.trim() || null;
        const practiceArea =
            classification?.practice_area?.trim() || null;

        // 4. Create the project (matter).
        const { data: project, error: projErr } = await db
            .from("projects")
            .insert({
                user_id: userId,
                name: matterTitle.slice(0, 120),
                shared_with: [],
            })
            .select("*")
            .single();
        if (projErr || !project) {
            await updateTaskStatus(
                envelope.task_id,
                { status: "draft" },
                db,
            );
            await recordAuditEvent(
                {
                    taskId: envelope.task_id,
                    userId,
                    type: "task.failed",
                    payload: {
                        detail: projErr?.message ?? "project insert failed",
                    },
                },
                db,
            );
            return void res
                .status(500)
                .json({ detail: "Failed to create matter" });
        }
        const projectId = project.id as string;

        // 5. Save the document under the new project.
        let savedDoc: { id: string; [key: string]: unknown };
        try {
            savedDoc = await saveUploadedDocument({
                file,
                userId,
                projectId,
                db,
            });
        } catch (err) {
            await updateTaskStatus(
                envelope.task_id,
                { status: "draft" },
                db,
            );
            await recordAuditEvent(
                {
                    taskId: envelope.task_id,
                    userId,
                    type: "task.failed",
                    payload: {
                        detail: err instanceof Error ? err.message : String(err),
                    },
                },
                db,
            );
            // Orphan the project so the user can find it if they reload.
            return void res.status(500).json({
                detail: `Document save failed: ${err instanceof Error ? err.message : String(err)}`,
                project_id: projectId,
            });
        }
        const documentId = savedDoc.id as string;

        // 5b. Seed the matter wiki (Karpathy three-layer pattern). Failure
        // is non-fatal — the matter still exists in Supabase; the agent can
        // populate the wiki later on demand.
        try {
            await ensureMatterWiki(projectId, {
                matterTitle,
                classification: (classification as unknown) as
                    | Record<string, unknown>
                    | null,
                firstDocument: { id: documentId, filename },
            });
        } catch (err) {
            console.warn(
                "[openclaw/intake] wiki seed failed (non-fatal)",
                err,
            );
        }

        // 6. Finalise the intake task.
        await updateTaskStatus(
            envelope.task_id,
            {
                status: "approved",
                artifact: {
                    kind: "intake_triage",
                    matter_title: matterTitle,
                    classification: classification ?? null,
                    project_id: projectId,
                    document_id: documentId,
                },
            },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "artifact.produced",
                payload: {
                    project_id: projectId,
                    document_id: documentId,
                    matter_title: matterTitle,
                    jurisdiction,
                    practice_area: practiceArea,
                },
            },
            db,
        );
        await recordAuditEvent(
            {
                taskId: envelope.task_id,
                userId,
                type: "task.completed",
                payload: { project_id: projectId },
            },
            db,
        );

        // 7. Send the response RIGHT NOW so the lawyer lands in the new
        // matter without waiting. Then fire the background ingest agent
        // — by the time they finish reading the project page, the wiki
        // is populated.
        res.status(201).json({
            project_id: projectId,
            project_name: project.name,
            document_id: documentId,
            document_filename: filename,
            matter_title: matterTitle,
            classification,
            intake_task_id: envelope.task_id,
        });

        kickoffBackgroundIngest({
            projectId,
            documentId,
            documentFilename: filename,
            userId,
            matterTitle,
            classification: (classification as unknown) as
                | Record<string, unknown>
                | null,
            model: selectedModel,
        });
        return;
    },
);
