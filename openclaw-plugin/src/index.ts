import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

// ---------------------------------------------------------------------------
// Mike OpenClaw plugin
// ---------------------------------------------------------------------------
// This plugin runs inside the OpenClaw gateway process and exposes Mike's
// legal-document tools to any agent session. Each tool is a thin HTTP
// client against Mike's Express backend at MIKE_API_URL — the real
// document-access logic stays in mike/backend, where Supabase/R2/audit
// already live.
//
// Tools shipped today (read-only):
//   - mike_list_documents
//   - mike_read_document
//
// Auth: the plugin sends `X-Mike-Internal: <token>` so Mike's backend
// can recognise the gateway as a trusted internal caller (the token is
// shared via the gateway process env). User scoping is by explicit
// user_id parameter — for Sean's single-operator setup, this is fine;
// multi-tenant deployments must add per-session user binding.

const DEFAULT_API_URL = "http://127.0.0.1:3001";
const CONFIG_PATH = join(homedir(), ".openclaw", "mike-tools.config.json");

type FileConfig = {
    api_url?: string;
    internal_token?: string;
};

let cachedFileConfig: FileConfig | null = null;
let attemptedFileLoad = false;

function loadFileConfig(): FileConfig {
    if (cachedFileConfig) return cachedFileConfig;
    if (attemptedFileLoad) return {};
    attemptedFileLoad = true;
    try {
        const raw = readFileSync(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw) as FileConfig;
        cachedFileConfig = parsed;
        return parsed;
    } catch {
        return {};
    }
}

function readEnv(name: string): string | undefined {
    const raw = process.env[name];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function apiUrl(): string {
    const fromEnv = readEnv("MIKE_API_URL");
    const fromFile = loadFileConfig().api_url?.trim();
    return (fromEnv ?? fromFile ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

function internalToken(): string | undefined {
    return readEnv("MIKE_INTERNAL_TOKEN") ?? loadFileConfig().internal_token;
}

type MikeError = {
    detail?: string;
    error?: string;
    message?: string;
};

async function postTool<T>(
    name: string,
    body: Record<string, unknown>,
): Promise<T> {
    const token = internalToken();
    if (!token) {
        throw new Error(
            `mike-tools plugin has no internal token. Set MIKE_INTERNAL_TOKEN in the gateway environment, or write { "internal_token": "...", "api_url": "..." } to ${CONFIG_PATH} and restart the gateway.`,
        );
    }
    const url = `${apiUrl()}/openclaw/tools/${name}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Mike-Internal": token,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const raw = await response.text().catch(() => "");
        let parsed: MikeError | null = null;
        try {
            parsed = JSON.parse(raw) as MikeError;
        } catch {
            /* leave as text */
        }
        const detail =
            parsed?.detail ?? parsed?.error ?? parsed?.message ?? raw.slice(0, 400);
        throw new Error(
            `mike ${name} failed: HTTP ${response.status} — ${detail || "no detail"}`,
        );
    }
    return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default defineToolPlugin({
    id: "mike-tools",
    name: "Mike Legal Tools",
    description:
        "Read and inspect documents stored in Mike (the legal-assistant app). Use when an agent needs the text of a Mike document to perform legal review, research, drafting, or timeline analysis.",
    tools: (tool) => [
        tool({
            name: "mike_list_documents",
            description:
                "List Mike documents available to a user, optionally scoped to a project. Returns each document's id, filename, file_type, and project_id. Use before mike_read_document to discover what's available.",
            parameters: Type.Object({
                user_id: Type.String({
                    description:
                        "Supabase user id whose documents to list. Required.",
                }),
                project_id: Type.Optional(
                    Type.String({
                        description:
                            "If set, only list documents belonging to this Mike project.",
                    }),
                ),
                limit: Type.Optional(
                    Type.Integer({
                        minimum: 1,
                        maximum: 200,
                        description:
                            "Maximum documents to return. Defaults to 50.",
                    }),
                ),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    documents: {
                        id: string;
                        filename: string;
                        file_type: string;
                        project_id: string | null;
                    }[];
                }>("list_documents", params);
                return result;
            },
        }),
        tool({
            name: "mike_read_document",
            description:
                "Read the full text of a Mike document by id. Returns plain text extracted from the active version (PDF or DOCX). Use sparingly for long docs — the response can be large. Always quote short excerpts back in your output rather than reproducing the whole document.",
            parameters: Type.Object({
                user_id: Type.String({
                    description:
                        "Supabase user id requesting the read (for access enforcement).",
                }),
                document_id: Type.String({
                    description: "Mike document id (uuid).",
                }),
                max_chars: Type.Optional(
                    Type.Integer({
                        minimum: 1,
                        maximum: 1_000_000,
                        description:
                            "Cap the returned text at this many characters. Mike will return text truncated at the cap with a `truncated: true` flag. Default 200000.",
                    }),
                ),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    document_id: string;
                    filename: string | null;
                    file_type: string | null;
                    text: string;
                    chars: number;
                    truncated: boolean;
                }>("read_document", params);
                return result;
            },
        }),

        // -------------------------------------------------------------------
        // Wiki tools — Karpathy three-layer compounding memory per matter.
        // Use these to maintain durable per-matter knowledge across sessions.
        // -------------------------------------------------------------------

        tool({
            name: "mike_wiki_list_matters",
            description:
                "List the matters (Mike projects) belonging to a user along with whether each has an associated wiki and when it was last updated. Use to orient when an operator asks about cross-matter work.",
            parameters: Type.Object({
                user_id: Type.String({
                    description: "Supabase user id whose matters to list.",
                }),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    matters: {
                        matter_id: string;
                        name: string | null;
                        project_created_at: string;
                        wiki_updated_at: string | null;
                        has_wiki: boolean;
                    }[];
                }>("wiki_list_matters", params);
                return result;
            },
        }),

        tool({
            name: "mike_wiki_index",
            description:
                "Return the list of wiki pages maintained for a specific matter, with each page's size and last-updated timestamp. Use BEFORE reading or writing wiki pages so you know what already exists. Returns paths relative to the matter dir (e.g. 'parties.md', 'sources/doc-abc.md').",
            parameters: Type.Object({
                user_id: Type.String({
                    description: "Supabase user id (for access check).",
                }),
                matter_id: Type.String({
                    description: "Mike project id (uuid) — the matter.",
                }),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    matter_id: string;
                    pages: {
                        page: string;
                        chars: number;
                        updated_at: string;
                    }[];
                }>("wiki_index", params);
                return result;
            },
        }),

        tool({
            name: "mike_wiki_read",
            description:
                "Read a single wiki page from a matter. Prefer this over re-reading the raw document — the wiki page is the compiled, citable, current view. Page names use forward slashes (e.g. 'sources/doc-abc.md').",
            parameters: Type.Object({
                user_id: Type.String({
                    description: "Supabase user id (for access check).",
                }),
                matter_id: Type.String({
                    description: "Mike project id (uuid) — the matter.",
                }),
                page: Type.String({
                    description:
                        "Page name within the matter, e.g. 'parties.md', 'risks.md', 'sources/doc-<id>.md'. Must end in .md.",
                }),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    matter_id: string;
                    page: string;
                    path: string;
                    chars: number;
                    content: string;
                }>("wiki_read", params);
                return result;
            },
        }),

        tool({
            name: "mike_wiki_write",
            description:
                "Overwrite a wiki page with new content. Use to update aggregate pages (parties.md, timeline.md, obligations.md, risks.md, definitions.md, open-questions.md) after ingesting a new document, or to file a new memo. Always read the existing page first so you don't lose prior content.",
            parameters: Type.Object({
                user_id: Type.String({
                    description: "Supabase user id (for access check).",
                }),
                matter_id: Type.String({
                    description: "Mike project id (uuid) — the matter.",
                }),
                page: Type.String({
                    description:
                        "Page name within the matter, must end in .md. Slashes for subpaths (e.g. 'sources/doc-abc.md').",
                }),
                content: Type.String({
                    description:
                        "Full new contents of the page. This REPLACES the existing file. Include YAML frontmatter with sources: list when applicable.",
                }),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    path: string;
                    bytes: number;
                }>("wiki_write", params);
                return result;
            },
        }),

        tool({
            name: "mike_wiki_append",
            description:
                "Append a single entry to a wiki page without rewriting it. Best for log.md and open-questions.md. Prefer mike_wiki_write for pages with structured aggregates.",
            parameters: Type.Object({
                user_id: Type.String({
                    description: "Supabase user id (for access check).",
                }),
                matter_id: Type.String({
                    description: "Mike project id (uuid) — the matter.",
                }),
                page: Type.String({
                    description:
                        "Page name within the matter, must end in .md.",
                }),
                entry: Type.String({
                    description:
                        "Text to append to the page. A trailing newline will be added if missing.",
                }),
            }),
            execute: async (params) => {
                const result = await postTool<{
                    path: string;
                    appended_bytes: number;
                }>("wiki_append", params);
                return result;
            },
        }),
    ],
});
