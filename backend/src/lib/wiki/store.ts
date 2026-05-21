import { promises as fsp, mkdirSync } from "fs";
import { dirname, join, resolve, normalize, sep, relative } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Mike compounding-wiki store (Karpathy's three-layer pattern, per matter)
// ---------------------------------------------------------------------------
//
// Three layers Mike already has:
//   raw     — documents table + R2/local FS bytes (lawyer uploads; LLM never edits)
//   wiki    — markdown files Mike maintains here (this module)
//   schema  — clawdbot/skills/mike-legal/SKILL.md + per-matter LLM_WIKI.md
//
// Layout under WIKI_ROOT (defaults to mike/backend/.wiki, override with
// MIKE_WIKI_DIR):
//
//   .wiki/
//     index.md                    top-level catalog of all matters
//     log.md                      top-level ops log
//     matter-<project_id>/
//       LLM_WIKI.md               per-matter schema
//       index.md                  page catalog
//       log.md                    matter ops log
//       parties.md                merged on every ingest
//       timeline.md
//       obligations.md
//       risks.md
//       definitions.md
//       open-questions.md
//       sources/
//         doc-<id>.md             one entry per source document
//       memos/                    human-readable synthesis pages
//
// Path-traversal safety: every read/write resolves the requested path
// and verifies it's still under the wiki root. matter_id must be a UUID.

const DEFAULT_WIKI_ROOT_REL = ".wiki";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Page paths permit slashes (e.g. "sources/doc-abc.md") but no leading slash,
// no ".." segments, only lowercase ASCII + digits + - _ . / and the .md
// suffix is enforced separately.
const PAGE_RE = /^[a-z0-9._\-/]+$/;

function backendRoot(): string {
    // dist/lib/wiki/store.js → backend = ../../..
    return resolve(__dirname, "..", "..", "..");
}

export function wikiRoot(): string {
    const override = process.env.MIKE_WIKI_DIR?.trim();
    if (override) return resolve(override.replace(/^~/, homedir()));
    return resolve(backendRoot(), DEFAULT_WIKI_ROOT_REL);
}

function assertValidMatterId(matterId: string): void {
    if (!UUID_RE.test(matterId)) {
        throw new WikiError(400, `Invalid matter_id: must be a UUID`);
    }
}

function assertValidPage(page: string): void {
    if (!page || page.length > 256) {
        throw new WikiError(400, "page is required and must be ≤256 chars");
    }
    if (!PAGE_RE.test(page)) {
        throw new WikiError(
            400,
            "page may only contain a-z 0-9 . _ - / (got: " + page + ")",
        );
    }
    if (page.includes("..") || page.startsWith("/")) {
        throw new WikiError(400, "page path traversal not allowed");
    }
    if (!page.endsWith(".md")) {
        throw new WikiError(400, "page must end in .md");
    }
}

function matterDir(matterId: string): string {
    assertValidMatterId(matterId);
    return resolve(wikiRoot(), `matter-${matterId}`);
}

function resolveMatterPagePath(matterId: string, page: string): string {
    const dir = matterDir(matterId);
    const target = resolve(dir, page);
    const root = wikiRoot();
    // Defence in depth: target must be inside the matter dir, which must be
    // inside the wiki root.
    if (
        !target.startsWith(dir + sep) &&
        target !== dir
    ) {
        throw new WikiError(400, "page escapes matter directory");
    }
    if (!target.startsWith(root + sep) && target !== root) {
        throw new WikiError(400, "page escapes wiki root");
    }
    return target;
}

export class WikiError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// Initialise root + per-matter skeleton
// ---------------------------------------------------------------------------

let ensuredRoot = false;
function ensureRoot(): string {
    const root = wikiRoot();
    if (!ensuredRoot) {
        try {
            mkdirSync(root, { recursive: true });
            ensuredRoot = true;
        } catch (err) {
            console.warn("[wiki] failed to create wiki root", root, err);
        }
    }
    return root;
}

const MATTER_SCHEMA = `# LLM Wiki — schema for this matter

This file is the **schema layer** for the compounding wiki for this matter.
It complements the firm-wide \`mike-legal\` skill and is maintained alongside
the matter, not replaced.

## Three layers

| Layer | Location | Who edits |
|-------|----------|-----------|
| Raw / canon | Mike documents under this matter (R2 / local FS bytes) | **Lawyer uploads** — never edited by LLM |
| Wiki | this directory (markdown pages) | LLM maintains via mike_wiki_* tools |
| Schema | this \`LLM_WIKI.md\` + the firm \`mike-legal\` skill | Lawyer + LLM co-evolve |

## Operations

### Ingest

When a new document lands in this matter:

1. Read the document via \`mike_read_document\`.
2. Update \`parties.md\`, \`timeline.md\`, \`obligations.md\`, \`risks.md\`,
   \`definitions.md\`, \`open-questions.md\` with anything new from this document.
3. Create or replace \`sources/doc-<id>.md\` with: summary, parties, key dates,
   key clauses, document-specific risks, citations back to specific sections.
4. Update \`index.md\` so the new page is discoverable.
5. Append a one-line entry to \`log.md\` with timestamp and what was changed.

### Query

When the lawyer asks a question about this matter:

1. \`mike_wiki_index\` to see what pages exist.
2. Read the pages most relevant to the question (use page-name keywords).
3. Answer with citations to both the wiki page AND the raw document.
4. If you learn something new during the query, file it back via
   \`mike_wiki_write\` or \`mike_wiki_append\` and update \`index.md\`.

### Lint

Periodically (e.g. nightly cron):

1. Scan \`log.md\` since the last lint.
2. Cross-check every wiki page for: contradictions, stale claims, orphan pages
   (no inbound links), missing cross-references, gaps where a raw document
   was ingested but no wiki page mentions it.
3. Produce a lint report and append to \`log.md\`.

## Provenance convention

Each wiki page SHOULD include YAML frontmatter with a \`sources:\` list of the
Mike \`document_id\`s it draws from. Use the document filename in prose; the
\`document_id\` only inside frontmatter and tool calls.

## Never put external-facing legal output here

This wiki is **internal working memory**. Any output destined for a client,
counterparty, court, or filing system goes through Mike's normal review +
approval flow, not the wiki.
`;

const EMPTY_PAGES: Record<string, string> = {
    "index.md":
        "# Matter index\n\nThis page lists every wiki page maintained for this matter.\n\n## Core pages\n\n- [LLM_WIKI.md](./LLM_WIKI.md) — schema for this matter\n- [parties.md](./parties.md) — parties and roles\n- [timeline.md](./timeline.md) — key dates and chronology\n- [obligations.md](./obligations.md) — running obligations register\n- [risks.md](./risks.md) — running risk register\n- [definitions.md](./definitions.md) — defined-terms table\n- [open-questions.md](./open-questions.md) — items the lawyer must verify\n- [log.md](./log.md) — append-only operations log\n\n## Sources\n\n- [sources/](./sources/) — one page per uploaded document\n\n## Memos\n\n- [memos/](./memos/) — human-readable synthesis pages\n",
    "log.md": "# Matter log\n\nAppend-only record of ingest, query, lint operations against this matter's wiki.\n\nFormat: `YYYY-MM-DD HH:MM:SS  <op>  <one-line summary>`\n",
    "parties.md":
        "# Parties\n\nWho is involved in this matter, in what role, in what jurisdiction.\n\n_Empty — populate on ingest._\n",
    "timeline.md":
        "# Timeline\n\nChronology of dated events relevant to this matter.\n\n_Empty — populate on ingest._\n",
    "obligations.md":
        "# Obligations\n\nRunning register of obligations each party owes, grouped by party.\n\n_Empty — populate on ingest._\n",
    "risks.md":
        "# Risks\n\nRunning register of risks, ambiguities, and unfavorable terms, with severity and rationale.\n\n_Empty — populate on ingest._\n",
    "definitions.md":
        "# Defined terms\n\nGlossary of defined terms across the matter's documents, with the canonical definition and which document defines it.\n\n_Empty — populate on ingest._\n",
    "open-questions.md":
        "# Open questions\n\nThings the lawyer must verify, missing facts, requests pending with the client.\n\n_Empty — populate on ingest._\n",
};

export async function ensureMatterWiki(
    matterId: string,
    seed?: {
        matterTitle?: string;
        classification?: Record<string, unknown> | null;
        firstDocument?: { id: string; filename: string };
    },
): Promise<{ path: string; created: boolean }> {
    ensureRoot();
    const dir = matterDir(matterId);
    let created = false;
    try {
        await fsp.stat(dir);
    } catch {
        created = true;
    }
    await fsp.mkdir(join(dir, "sources"), { recursive: true });
    await fsp.mkdir(join(dir, "memos"), { recursive: true });

    // Write skeleton pages — only when missing so re-ingest doesn't clobber
    // anything the LLM has already populated.
    const headerLine = seed?.matterTitle
        ? `# ${seed.matterTitle}\n\nMatter wiki for project \`${matterId}\`.\n`
        : `# Matter ${matterId}\n\nMatter wiki.\n`;
    const schemaWithHeader = headerLine + "\n---\n\n" + MATTER_SCHEMA;
    await writeIfMissing(join(dir, "LLM_WIKI.md"), schemaWithHeader);
    for (const [name, body] of Object.entries(EMPTY_PAGES)) {
        await writeIfMissing(join(dir, name), body);
    }

    if (seed?.classification && Object.keys(seed.classification).length > 0) {
        const lines = ["# Intake classification", ""];
        for (const [k, v] of Object.entries(seed.classification)) {
            lines.push(`- **${k}**: ${formatScalar(v)}`);
        }
        lines.push("");
        await writeIfMissing(join(dir, "intake-classification.md"), lines.join("\n"));
    }

    if (seed?.firstDocument) {
        const sourcePath = join(
            dir,
            "sources",
            `doc-${seed.firstDocument.id}.md`,
        );
        await writeIfMissing(
            sourcePath,
            [
                `---`,
                `document_id: ${seed.firstDocument.id}`,
                `filename: ${seed.firstDocument.filename}`,
                `---`,
                ``,
                `# ${seed.firstDocument.filename}`,
                ``,
                `_Empty — populate on ingest._`,
                ``,
            ].join("\n"),
        );
    }

    await appendLog(
        matterId,
        created ? "matter.wiki.created" : "matter.wiki.seeded",
        seed?.matterTitle
            ? `${seed.matterTitle}${seed.firstDocument ? ` (doc ${seed.firstDocument.id})` : ""}`
            : seed?.firstDocument
              ? `seeded with doc ${seed.firstDocument.id}`
              : "schema only",
    );

    return { path: dir, created };
}

function formatScalar(v: unknown): string {
    if (v == null) return "_unspecified_";
    if (Array.isArray(v)) return v.map((x) => formatScalar(x)).join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

async function writeIfMissing(path: string, body: string): Promise<void> {
    try {
        await fsp.stat(path);
        return; // exists; leave alone
    } catch {
        await fsp.mkdir(dirname(path), { recursive: true });
        await fsp.writeFile(path, body, "utf8");
    }
}

// ---------------------------------------------------------------------------
// Plugin-facing operations
// ---------------------------------------------------------------------------

export type WikiPage = {
    matter_id: string;
    page: string;
    path: string;
    chars: number;
    content: string;
};

export async function readWikiPage(
    matterId: string,
    page: string,
): Promise<WikiPage> {
    assertValidPage(page);
    const target = resolveMatterPagePath(matterId, page);
    try {
        const content = await fsp.readFile(target, "utf8");
        return {
            matter_id: matterId,
            page,
            path: relative(wikiRoot(), target),
            chars: content.length,
            content,
        };
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            throw new WikiError(404, `wiki page not found: ${page}`);
        }
        throw err;
    }
}

export async function writeWikiPage(
    matterId: string,
    page: string,
    content: string,
): Promise<{ path: string; bytes: number }> {
    assertValidPage(page);
    const target = resolveMatterPagePath(matterId, page);
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
    await appendLog(
        matterId,
        "wiki.write",
        `${page} (${content.length} chars)`,
    );
    return { path: relative(wikiRoot(), target), bytes: content.length };
}

export async function appendWikiPage(
    matterId: string,
    page: string,
    entry: string,
): Promise<{ path: string; appended_bytes: number }> {
    assertValidPage(page);
    const target = resolveMatterPagePath(matterId, page);
    await fsp.mkdir(dirname(target), { recursive: true });
    const suffix = entry.endsWith("\n") ? entry : entry + "\n";
    await fsp.appendFile(target, suffix, "utf8");
    if (page !== "log.md") {
        await appendLog(
            matterId,
            "wiki.append",
            `${page} (+${suffix.length} chars)`,
        );
    }
    return { path: relative(wikiRoot(), target), appended_bytes: suffix.length };
}

async function appendLog(
    matterId: string,
    op: string,
    summary: string,
): Promise<void> {
    const line = `${new Date().toISOString()}  ${op}  ${summary}\n`;
    const target = resolveMatterPagePath(matterId, "log.md");
    try {
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.appendFile(target, line, "utf8");
    } catch (err) {
        console.warn("[wiki] log append failed", matterId, op, err);
    }
}

export async function indexMatter(
    matterId: string,
): Promise<{ matter_id: string; pages: { page: string; chars: number; updated_at: string }[] }> {
    const dir = matterDir(matterId);
    const out: { page: string; chars: number; updated_at: string }[] = [];
    await walkDir(dir, dir, out);
    out.sort((a, b) => a.page.localeCompare(b.page));
    return { matter_id: matterId, pages: out };
}

async function walkDir(
    dir: string,
    root: string,
    out: { page: string; chars: number; updated_at: string }[],
): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return;
        throw err;
    }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkDir(full, root, out);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const stat = await fsp.stat(full);
            const rel = relative(root, full).split(sep).join("/");
            out.push({
                page: rel,
                chars: stat.size,
                updated_at: stat.mtime.toISOString(),
            });
        }
    }
}

export async function listMatters(): Promise<{
    matters: { matter_id: string; updated_at: string }[];
}> {
    ensureRoot();
    const root = wikiRoot();
    const out: { matter_id: string; updated_at: string }[] = [];
    let entries: import("fs").Dirent[];
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") return { matters: [] };
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith("matter-")) continue;
        const matterId = entry.name.slice("matter-".length);
        if (!UUID_RE.test(matterId)) continue;
        try {
            const stat = await fsp.stat(join(root, entry.name));
            out.push({ matter_id: matterId, updated_at: stat.mtime.toISOString() });
        } catch {
            /* ignore */
        }
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { matters: out };
}

// ---------------------------------------------------------------------------
// __dirname shim for ESM-style builds (tsc emits CJS by default for this
// project so __dirname is defined; this is here in case the module-mode
// changes).
// ---------------------------------------------------------------------------

declare const __dirname: string;
