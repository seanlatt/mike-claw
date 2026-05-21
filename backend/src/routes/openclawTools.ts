import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { extractPdfText } from "../lib/chatTools";
import {
    readWikiPage,
    writeWikiPage,
    appendWikiPage,
    indexMatter,
    listMatters,
    WikiError,
} from "../lib/wiki/store";

// ---------------------------------------------------------------------------
// Mike <- OpenClaw gateway tool bridge
// ---------------------------------------------------------------------------
// The mike-tools OpenClaw plugin runs inside the gateway process and proxies
// tool calls here. We don't require a Supabase user JWT — instead, the
// route is gated by a shared secret in MIKE_INTERNAL_TOKEN. The gateway is
// treated as a trusted internal caller; per-user scoping is enforced by
// requiring `user_id` in every tool body.
//
// Routes:
//   POST /openclaw/tools/list_documents  { user_id, project_id?, limit? }
//   POST /openclaw/tools/read_document   { user_id, document_id, max_chars? }
//
// All routes return JSON.

export const openclawToolsRouter = Router();

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_READ_CAP = 200_000;

function requireInternalToken(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const expected = process.env.MIKE_INTERNAL_TOKEN?.trim();
    if (!expected) {
        res.status(503).json({
            detail:
                "MIKE_INTERNAL_TOKEN is not configured on the backend — /openclaw/tools/* is disabled.",
        });
        return;
    }
    const supplied = (req.headers["x-mike-internal"] ?? "")
        .toString()
        .trim();
    if (!supplied || supplied !== expected) {
        res.status(401).json({ detail: "Invalid or missing X-Mike-Internal" });
        return;
    }
    next();
}

openclawToolsRouter.use(requireInternalToken);

// ---------------------------------------------------------------------------
// POST /openclaw/tools/list_documents
// ---------------------------------------------------------------------------

openclawToolsRouter.post("/list_documents", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const projectId = (req.body?.project_id as string | undefined)?.trim();
    const rawLimit = req.body?.limit;
    const limit = Math.max(
        1,
        Math.min(
            200,
            typeof rawLimit === "number" && Number.isFinite(rawLimit)
                ? Math.floor(rawLimit)
                : DEFAULT_LIST_LIMIT,
        ),
    );

    if (!userId) {
        return void res
            .status(400)
            .json({ detail: "user_id is required" });
    }

    const db = createServerSupabase();
    let query = db
        .from("documents")
        .select("id, filename, file_type, project_id, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
    if (projectId) {
        query = query.eq("project_id", projectId);
    }

    const { data, error } = await query;
    if (error) {
        console.error("[openclaw-tools/list_documents]", error);
        return void res.status(500).json({ detail: error.message });
    }

    res.json({
        documents: (data ?? []).map((row) => ({
            id: row.id as string,
            filename: (row.filename as string) ?? null,
            file_type: (row.file_type as string) ?? null,
            project_id: (row.project_id as string | null) ?? null,
        })),
    });
});

// ---------------------------------------------------------------------------
// POST /openclaw/tools/read_document
// ---------------------------------------------------------------------------

openclawToolsRouter.post("/read_document", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const documentId = (req.body?.document_id as string | undefined)?.trim();
    const rawCap = req.body?.max_chars;
    const maxChars = Math.max(
        1,
        Math.min(
            1_000_000,
            typeof rawCap === "number" && Number.isFinite(rawCap)
                ? Math.floor(rawCap)
                : DEFAULT_READ_CAP,
        ),
    );

    if (!userId) {
        return void res.status(400).json({ detail: "user_id is required" });
    }
    if (!documentId) {
        return void res
            .status(400)
            .json({ detail: "document_id is required" });
    }

    const db = createServerSupabase();
    const { data: doc, error } = await db
        .from("documents")
        .select("id, user_id, project_id, filename, file_type")
        .eq("id", documentId)
        .single();
    if (error || !doc) {
        return void res.status(404).json({ detail: "Document not found" });
    }
    if (doc.user_id !== userId && !doc.project_id) {
        // Per-user scoping: gateway is trusted, but we still won't hand
        // a private doc owned by user A to user B. If the doc is in a
        // project, project-level sharing applies via existing helpers,
        // but for v1 the plugin operates owner-scoped only.
        return void res.status(404).json({ detail: "Document not found" });
    }
    if (doc.user_id !== userId && doc.project_id) {
        // We don't have userEmail here; reject cross-user reads even via
        // project for now. Project sharing through this surface can be
        // added later with an explicit allowlist.
        return void res.status(403).json({ detail: "Forbidden" });
    }

    const active = await loadActiveVersion(documentId, db);
    if (!active) {
        return void res
            .status(404)
            .json({ detail: "Document has no active version" });
    }
    const bytes = await downloadFile(active.storage_path);
    if (!bytes) {
        return void res
            .status(500)
            .json({ detail: "Document storage unreachable" });
    }

    const fileType = ((doc.file_type as string | undefined) ?? "").toLowerCase();
    let text = "";
    try {
        if (fileType === "docx" || fileType === "doc") {
            text = await extractDocxBodyText(Buffer.from(bytes));
        } else if (fileType === "pdf") {
            text = await extractPdfText(bytes);
        } else {
            text = Buffer.from(bytes).toString("utf-8");
        }
    } catch (err) {
        console.error("[openclaw-tools/read_document] extract failed:", err);
        return void res
            .status(500)
            .json({ detail: "Failed to extract document text" });
    }

    const truncated = text.length > maxChars;
    const out = truncated ? text.slice(0, maxChars) : text;

    res.json({
        document_id: documentId,
        filename: (doc.filename as string) ?? null,
        file_type: (doc.file_type as string) ?? null,
        text: out,
        chars: out.length,
        truncated,
    });
});

// ---------------------------------------------------------------------------
// Wiki tools — Karpathy three-layer compounding-memory pattern, per matter.
//
// Per-user access control: every wiki call (except list_matters) requires
// matter_id, and we verify the calling user_id owns or has access to that
// project via Mike's existing projects table. This is the same model as
// the document tools above — the gateway is trusted-internal, but per-user
// scoping must still be enforced.
// ---------------------------------------------------------------------------

async function userCanAccessMatter(
    db: ReturnType<typeof createServerSupabase>,
    matterId: string,
    userId: string,
): Promise<boolean> {
    const { data } = await db
        .from("projects")
        .select("id, user_id, shared_with")
        .eq("id", matterId)
        .single();
    if (!data) return false;
    if ((data.user_id as string) === userId) return true;
    // shared_with is jsonb (array of emails). For an internal tool call we
    // accept user_id-based ownership only; future enhancement can add
    // per-email sharing if needed.
    return false;
}

function wikiErrorStatus(err: unknown): { status: number; detail: string } {
    if (err instanceof WikiError) {
        return { status: err.status, detail: err.message };
    }
    return {
        status: 500,
        detail: err instanceof Error ? err.message : String(err),
    };
}

openclawToolsRouter.post("/wiki_list_matters", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    if (!userId) {
        return void res.status(400).json({ detail: "user_id is required" });
    }
    const db = createServerSupabase();
    const { data, error } = await db
        .from("projects")
        .select("id, name, created_at, updated_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
    if (error) {
        return void res.status(500).json({ detail: error.message });
    }
    try {
        const wikiInfo = await listMatters();
        const wikiByMatter = new Map(
            wikiInfo.matters.map((m) => [m.matter_id, m.updated_at] as const),
        );
        const out = (data ?? []).map((p) => ({
            matter_id: p.id as string,
            name: (p.name as string) ?? null,
            project_created_at: p.created_at as string,
            wiki_updated_at: wikiByMatter.get(p.id as string) ?? null,
            has_wiki: wikiByMatter.has(p.id as string),
        }));
        res.json({ matters: out });
    } catch (err) {
        const e = wikiErrorStatus(err);
        res.status(e.status).json({ detail: e.detail });
    }
});

openclawToolsRouter.post("/wiki_index", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const matterId = (req.body?.matter_id as string | undefined)?.trim();
    if (!userId || !matterId) {
        return void res
            .status(400)
            .json({ detail: "user_id and matter_id are required" });
    }
    const db = createServerSupabase();
    const ok = await userCanAccessMatter(db, matterId, userId);
    if (!ok) return void res.status(404).json({ detail: "matter not found" });
    try {
        const result = await indexMatter(matterId);
        res.json(result);
    } catch (err) {
        const e = wikiErrorStatus(err);
        res.status(e.status).json({ detail: e.detail });
    }
});

openclawToolsRouter.post("/wiki_read", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const matterId = (req.body?.matter_id as string | undefined)?.trim();
    const page = (req.body?.page as string | undefined)?.trim();
    if (!userId || !matterId || !page) {
        return void res
            .status(400)
            .json({ detail: "user_id, matter_id, page are required" });
    }
    const db = createServerSupabase();
    const ok = await userCanAccessMatter(db, matterId, userId);
    if (!ok) return void res.status(404).json({ detail: "matter not found" });
    try {
        const result = await readWikiPage(matterId, page);
        res.json(result);
    } catch (err) {
        const e = wikiErrorStatus(err);
        res.status(e.status).json({ detail: e.detail });
    }
});

openclawToolsRouter.post("/wiki_write", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const matterId = (req.body?.matter_id as string | undefined)?.trim();
    const page = (req.body?.page as string | undefined)?.trim();
    const content = req.body?.content as string | undefined;
    if (!userId || !matterId || !page || typeof content !== "string") {
        return void res
            .status(400)
            .json({
                detail:
                    "user_id, matter_id, page, content are required",
            });
    }
    const db = createServerSupabase();
    const ok = await userCanAccessMatter(db, matterId, userId);
    if (!ok) return void res.status(404).json({ detail: "matter not found" });
    try {
        const result = await writeWikiPage(matterId, page, content);
        res.json(result);
    } catch (err) {
        const e = wikiErrorStatus(err);
        res.status(e.status).json({ detail: e.detail });
    }
});

openclawToolsRouter.post("/wiki_append", async (req, res) => {
    const userId = (req.body?.user_id as string | undefined)?.trim();
    const matterId = (req.body?.matter_id as string | undefined)?.trim();
    const page = (req.body?.page as string | undefined)?.trim();
    const entry = req.body?.entry as string | undefined;
    if (!userId || !matterId || !page || typeof entry !== "string") {
        return void res
            .status(400)
            .json({
                detail:
                    "user_id, matter_id, page, entry are required",
            });
    }
    const db = createServerSupabase();
    const ok = await userCanAccessMatter(db, matterId, userId);
    if (!ok) return void res.status(404).json({ detail: "matter not found" });
    try {
        const result = await appendWikiPage(matterId, page, entry);
        res.json(result);
    } catch (err) {
        const e = wikiErrorStatus(err);
        res.status(e.status).json({ detail: e.detail });
    }
});
