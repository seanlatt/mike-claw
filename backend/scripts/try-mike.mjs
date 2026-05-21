#!/usr/bin/env node
// try-mike.mjs — End-to-end smoke for the Mike ↔ OpenClaw integration.
//
// What this does:
//   1. Spins up a mock Mike backend on http://127.0.0.1:3001 that
//      answers /openclaw/tools/* with a small fixture document.
//   2. Calls Mike's openclaw adapter with mike_list_documents +
//      mike_read_document in the tool list.
//   3. The adapter talks to the real OpenClaw gateway (default
//      provider — Grok 4.3 over xAI OAuth on Sean's setup), which
//      replies with tool calls in the JSON-fence protocol.
//   4. Adapter routes the calls to the gateway plugin via tools.invoke;
//      plugin makes HTTP calls back to the mock; results feed back to
//      the model; final answer is rendered.
//
// Prerequisites:
//   - OpenClaw gateway is running (openclaw gateway status)
//   - mike-tools plugin is installed (openclaw plugins list | grep mike-tools)
//   - ~/.openclaw/mike-tools.config.json has internal_token set
//   - npm run build has been run in mike/backend
//
// No Supabase. No R2. No frontend.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const backendRoot = resolve(here, "..");
const adapterPath = join(backendRoot, "dist", "lib", "llm", "openclaw.js");

if (!existsSync(adapterPath)) {
    console.error(
        `Adapter not built. Run \`npm run build\` in ${backendRoot} first.`,
    );
    process.exit(1);
}

const configPath = join(homedir(), ".openclaw", "mike-tools.config.json");
if (!existsSync(configPath)) {
    console.error(
        `Plugin config missing: ${configPath}\n` +
            `Write { "internal_token": "...", "api_url": "http://127.0.0.1:3001" } then re-run.`,
    );
    process.exit(1);
}
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const TOKEN = cfg.internal_token;
if (!TOKEN) {
    console.error(`internal_token not set in ${configPath}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Mock backend — same shape as routes/openclawTools.ts.
// ---------------------------------------------------------------------------

const FIXTURE_DOCS = [
    {
        id: "doc-nda-001",
        filename: "NDA-Acme-Beta.docx",
        file_type: "docx",
        project_id: null,
        text:
            "MUTUAL NON-DISCLOSURE AGREEMENT\n\n" +
            "This Mutual Non-Disclosure Agreement (the 'Agreement') is entered into as of January 1, 2026 (the 'Effective Date'), by and between Acme Co. ('Acme'), a Delaware corporation, and Beta LLC ('Beta'), a California limited liability company.\n\n" +
            "1. Term. This Agreement shall remain in effect for five (5) years from the Effective Date, unless earlier terminated.\n\n" +
            "2. Termination. Either party may terminate this Agreement upon thirty (30) days written notice to the other.\n\n" +
            "3. Governing Law. This Agreement shall be governed by the laws of the State of California, without regard to its conflicts-of-laws principles.\n\n" +
            "4. Confidentiality. Each party agrees to protect the other party's Confidential Information.\n\n" +
            "(No survival clause is included.)",
    },
    {
        id: "doc-msa-002",
        filename: "MSA-draft-v3.pdf",
        file_type: "pdf",
        project_id: "proj-acme",
        text: "[Master Services Agreement — placeholder text]",
    },
];

const mock = http.createServer((req, res) => {
    if (!req.url?.startsWith("/openclaw/tools/")) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ detail: "not found" }));
    }
    if (req.headers["x-mike-internal"] !== TOKEN) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ detail: "bad token" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        let args;
        try {
            args = body ? JSON.parse(body) : {};
        } catch {
            res.statusCode = 400;
            return res.end(JSON.stringify({ detail: "bad json" }));
        }
        const tool = req.url.split("/").pop();
        console.log(`  [mock] ${tool} ${JSON.stringify(args)}`);
        res.setHeader("Content-Type", "application/json");
        if (tool === "list_documents") {
            const filtered = args.project_id
                ? FIXTURE_DOCS.filter((d) => d.project_id === args.project_id)
                : FIXTURE_DOCS;
            res.end(
                JSON.stringify({
                    documents: filtered
                        .slice(0, args.limit ?? 50)
                        .map(({ id, filename, file_type, project_id }) => ({
                            id,
                            filename,
                            file_type,
                            project_id,
                        })),
                }),
            );
        } else if (tool === "read_document") {
            const doc = FIXTURE_DOCS.find((d) => d.id === args.document_id);
            if (!doc) {
                res.statusCode = 404;
                return res.end(JSON.stringify({ detail: "not found" }));
            }
            const cap = args.max_chars ?? 200_000;
            const text = doc.text.slice(0, cap);
            res.end(
                JSON.stringify({
                    document_id: doc.id,
                    filename: doc.filename,
                    file_type: doc.file_type,
                    text,
                    chars: text.length,
                    truncated: text.length < doc.text.length,
                }),
            );
        } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ detail: `unknown tool: ${tool}` }));
        }
    });
});

await new Promise((r) => mock.listen(3001, "127.0.0.1", r));
console.log("✓ mock Mike backend listening on http://127.0.0.1:3001");

// ---------------------------------------------------------------------------
// Run the adapter.
// ---------------------------------------------------------------------------

const { streamOpenClaw } = await import(adapterPath);

const tools = [
    {
        type: "function",
        function: {
            name: "mike_list_documents",
            description:
                "List Mike documents for a user. Returns id, filename, file_type, project_id per row.",
            parameters: {
                type: "object",
                properties: {
                    user_id: { type: "string" },
                    project_id: { type: "string" },
                    limit: { type: "integer" },
                },
                required: ["user_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "mike_read_document",
            description:
                "Read the extracted text of a single Mike document. Required: user_id, document_id.",
            parameters: {
                type: "object",
                properties: {
                    user_id: { type: "string" },
                    document_id: { type: "string" },
                    max_chars: { type: "integer" },
                },
                required: ["user_id", "document_id"],
            },
        },
    },
];

const USER_ID = "u-demo-001";

const systemPrompt = [
    "You are Mike's legal-assistant agent. You have read-only access to Mike's documents via mike_* tools.",
    `The current user's user_id is ${USER_ID}. Use it in every tool call.`,
    "Workflow for document review: list → read → review.",
    "Required output format for a review:",
    "- Summary (2–3 sentences)",
    "- Parties",
    "- Key dates and term",
    "- Risks and unfavorable terms (bullet list, each one short)",
    "- Missing facts (bullet list)",
    "- Recommended next actions (bullet list)",
    "End with exactly: Review status: needs human review",
].join("\n");

console.log("\n--- conversation ---\n");
const toolStarts = [];
const startedAt = Date.now();

const result = await streamOpenClaw({
    model: "openclaw/default",
    systemPrompt,
    messages: [
        {
            role: "user",
            content:
                "Find any NDA in Mike for me, read it, and give me a legal review.",
        },
    ],
    tools,
    maxIterations: 5,
    callbacks: {
        onContentDelta: (delta) => process.stdout.write(delta),
        onToolCallStart: (call) => {
            toolStarts.push(call.name);
            process.stdout.write(`\n\n  [tool: ${call.name}]\n\n`);
        },
    },
});

console.log("\n\n--- run summary ---");
console.log(`tool chain      : ${toolStarts.join(" → ") || "(none)"}`);
console.log(`duration        : ${Date.now() - startedAt}ms`);
console.log(`response length : ${result.fullText.length} chars`);
console.log(
    `has review tag  : ${/Review status:\s*needs human review/i.test(result.fullText)}`,
);

mock.close();
