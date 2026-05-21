import type { OpenAIToolSchema } from "../llm";

// ---------------------------------------------------------------------------
// Wiki tool schemas surfaced to Mike's chat tool catalog.
//
// These mirror the mike-tools OpenClaw plugin (see mike/openclaw-plugin/),
// which is what actually executes them. Mike's chat route exposes them
// here so the model — under the openclaw provider's JSON-fence protocol —
// sees them in its tool catalog and can call them naturally without the
// lawyer ever knowing they exist.
//
// Tools prefixed `mike_` route through the gateway plugin (no in-process
// runTools wiring needed) per the streamOpenClawWithTools dispatch in
// lib/llm/openclaw.ts.

export const MIKE_WIKI_TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: "mike_wiki_index",
            description:
                "Return the list of wiki pages maintained for the current matter, with size and last-updated. Call this FIRST whenever you're about to reason about the matter — the wiki has the compiled, current view; reading raw documents repeatedly is wasteful.",
            parameters: {
                type: "object",
                properties: {
                    user_id: {
                        type: "string",
                        description: "Supabase user id (in the matter context).",
                    },
                    matter_id: {
                        type: "string",
                        description: "matter_id (current project id from context).",
                    },
                },
                required: ["user_id", "matter_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "mike_wiki_read",
            description:
                "Read a single wiki page from the current matter. Page names use forward slashes (e.g. 'sources/doc-abc.md'). Prefer reading a wiki page over re-reading the underlying source document — the wiki page is the compiled, citable view.",
            parameters: {
                type: "object",
                properties: {
                    user_id: { type: "string" },
                    matter_id: { type: "string" },
                    page: {
                        type: "string",
                        description:
                            "Page name within the matter, must end in .md.",
                    },
                },
                required: ["user_id", "matter_id", "page"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "mike_wiki_write",
            description:
                "Overwrite a wiki page with new content. Use after learning something new from a source document so the matter's compounding memory stays current. Always read the existing page first if it might contain prior content. Include YAML frontmatter with `sources:` list of document_ids when applicable.",
            parameters: {
                type: "object",
                properties: {
                    user_id: { type: "string" },
                    matter_id: { type: "string" },
                    page: {
                        type: "string",
                        description:
                            "Page name within the matter (e.g. 'risks.md', 'sources/doc-abc.md'). Must end in .md.",
                    },
                    content: {
                        type: "string",
                        description:
                            "Full new contents of the page. REPLACES the existing file.",
                    },
                },
                required: ["user_id", "matter_id", "page", "content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "mike_wiki_append",
            description:
                "Append a single entry to a wiki page without rewriting it. Best for log.md and open-questions.md. Mike auto-logs writes/appends to log.md, so you don't need to log your own wiki operations.",
            parameters: {
                type: "object",
                properties: {
                    user_id: { type: "string" },
                    matter_id: { type: "string" },
                    page: { type: "string" },
                    entry: {
                        type: "string",
                        description:
                            "Text to append. A trailing newline is added if missing.",
                    },
                },
                required: ["user_id", "matter_id", "page", "entry"],
            },
        },
    },
];
