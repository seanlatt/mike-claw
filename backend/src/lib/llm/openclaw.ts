import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type {
    NormalizedToolCall,
    NormalizedToolResult,
    StreamChatParams,
    StreamChatResult,
} from "./types";

// ---------------------------------------------------------------------------
// OpenClaw runtime adapter
// ---------------------------------------------------------------------------
// Mike speaks Mike's normalized streamChatWithTools contract. This adapter
// translates a turn into a single `agent` RPC call against the local
// OpenClaw gateway via the `openclaw` CLI.
//
// We deliberately stay on the CLI subprocess instead of opening a raw
// WebSocket: the CLI handles auth, profile resolution, idempotency, and
// session bookkeeping. The cost is ~1–2s of Node spawn overhead per turn.
//
// What's supported today:
// - Real Grok inference through the OpenClaw gateway (agentId=main)
// - Per-turn isolated sessions so chats don't bleed into each other
// - Provider/model override when the caller passes a real provider/model
// - Fake-streaming of the returned text to preserve Mike's SSE contract
// - Mock mode (OPENCLAW_USE_MOCK=true) for offline UI dev
//
// What is NOT yet supported (intentional — leaves room for a real WS impl):
// - Tool calls. If the caller hands us tools, we log a warning and proceed
//   without them. Mike's chat route will still see content_delta events,
//   just no tool_call_start events. Callers wanting full document edits
//   should keep using claude/* or gemini/* until the gateway tool path
//   is wired.

const DEFAULT_AGENT_ID = "main";
const DEFAULT_TIMEOUT_MS = 120_000;

type AgentResult = {
    runId?: string;
    status?: string;
    summary?: string;
    result?: {
        payloads?: { text?: string | null; mediaUrl?: string | null }[];
        meta?: {
            agentMeta?: {
                provider?: string;
                model?: string;
                sessionId?: string;
            };
        };
    };
};

function agentId(): string {
    return process.env.OPENCLAW_AGENT_ID?.trim() || DEFAULT_AGENT_ID;
}

function gatewayTimeoutMs(): number {
    const raw = Number(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function clawCli(): string {
    // We use OPENCLAW_CLI_PATH (not OPENCLAW_CLI) because the launchd
    // gateway service exports OPENCLAW_CLI=1 as a marker, which would
    // collide if we read that name directly.
    return process.env.OPENCLAW_CLI_PATH?.trim() || "openclaw";
}

// ---------------------------------------------------------------------------
// Model id mapping
// ---------------------------------------------------------------------------
// Mike's model picker emits ids like `openclaw/default`, `openclaw/grok`,
// `openclaw/gpt-4o`. The gateway wants a `<provider>/<model>` split that
// matches its catalog (e.g. `xai/grok-4.3`). We translate here so the rest
// of Mike never has to think about it.

function resolveProviderModel(mikeModel: string): {
    provider?: string;
    model?: string;
} {
    const grokDefault =
        process.env.OPENCLAW_GROK_MODEL?.trim() || "grok-4.3";
    const openaiDefault =
        process.env.OPENCLAW_OPENAI_MODEL?.trim() || "gpt-4o";

    if (mikeModel === "openclaw/default" || mikeModel === "openclaw") {
        // Let the gateway use its configured default provider+model.
        // No override = no admin scope required.
        return {};
    }
    if (mikeModel === "openclaw/grok") {
        return { provider: "xai", model: grokDefault };
    }
    if (mikeModel === "openclaw/gpt-4o") {
        return { provider: "openai", model: openaiDefault };
    }
    // Pass-through: `openclaw/<provider>/<model>` -> provider+model
    if (mikeModel.startsWith("openclaw/")) {
        const rest = mikeModel.slice("openclaw/".length);
        const slash = rest.indexOf("/");
        if (slash > 0) {
            return {
                provider: rest.slice(0, slash),
                model: rest.slice(slash + 1),
            };
        }
    }
    return {};
}

// ---------------------------------------------------------------------------
// Prompt flattening
// ---------------------------------------------------------------------------
// `openclaw gateway call agent` takes a single `message` field and an
// optional system prompt is folded into the agent's bootstrap, not the call.
// So we concatenate Mike's systemPrompt + message history into one prompt.
// Mike's chatTools layer is responsible for keeping turn history correct;
// we just preserve it verbatim.

function flattenPrompt(
    systemPrompt: string,
    messages: { role: "user" | "assistant"; content: string }[],
    toolCatalog?: string,
): string {
    const parts: string[] = [];
    if (systemPrompt?.trim()) {
        parts.push("# SYSTEM\n" + systemPrompt.trim());
    }
    if (toolCatalog) {
        parts.push(toolCatalog);
    }
    for (const m of messages) {
        const tag = m.role === "assistant" ? "ASSISTANT" : "USER";
        parts.push(`# ${tag}\n${m.content}`);
    }
    parts.push("# ASSISTANT");
    return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool catalog + JSON-fence protocol
// ---------------------------------------------------------------------------
// The gateway's `agent` RPC in modelRun mode doesn't drive native tool
// calling — the response is plain text. To give Mike's tool-using chats
// claw-native tool access, we instruct the model to emit tool calls
// inside an explicit fence:
//
//   <<<TOOL_CALL>>>{"name": "...", "input": {...}}<<<END>>>
//
// We detect the fence, parse the JSON, dispatch (mike_* tools through
// the gateway's `tools.invoke`, everything else through Mike's
// in-process `runTools`), then append the assistant turn + tool results
// to the conversation and re-call.

// We emit `<<<TOOL_CALL>>>...<<<END>>>` in the catalog, but accept any
// number (>=2) of trailing chevrons on either fence — Grok occasionally
// drops one and we'd rather forgive than fail the loop.
const TOOL_FENCE_OPEN = "<<<TOOL_CALL>>>";
const TOOL_FENCE_CLOSE = "<<<END>>>";
const TOOL_FENCE_OPEN_RE = /<<<\s*TOOL_CALL\s*>{2,3}/g;
const TOOL_FENCE_CLOSE_RE = /<<<\s*END\s*>{2,3}/;
const MIKE_TOOL_PREFIX = "mike_";

function buildToolCatalog(
    tools: NonNullable<StreamChatParams["tools"]>,
): string {
    if (tools.length === 0) return "";
    const lines: string[] = [
        "# AVAILABLE TOOLS",
        "",
        "You have the following tools. To invoke one, emit this block in your response:",
        "",
        `${TOOL_FENCE_OPEN}{"name": "<tool_name>", "input": {<args>}}${TOOL_FENCE_CLOSE}`,
        "",
        "Rules:",
        "- The JSON inside the fence must be valid and on a single line.",
        "- You may include reasoning text before a tool call. Anything after the fence in the same turn is ignored.",
        "- After the tool runs you'll see its result in the next user turn under `TOOL RESULTS:` and can call another tool or produce your final answer.",
        "- Do NOT include a tool-call fence inside your final user-facing answer.",
        "- You may emit multiple tool fences in one turn (they run in parallel).",
        "",
    ];
    for (const t of tools) {
        lines.push(`## ${t.function.name}`);
        if (t.function.description) lines.push(t.function.description);
        try {
            lines.push(
                "Input schema: " +
                    JSON.stringify(t.function.parameters ?? {}),
            );
        } catch {
            /* skip schema */
        }
        lines.push("");
    }
    return lines.join("\n");
}

type ParsedToolCall = {
    rawIndex: number;
    name: string;
    input: Record<string, unknown>;
};

type ParsedTurn = {
    preToolText: string;
    toolCalls: ParsedToolCall[];
    /** Raw assistant text including the fences — fed back into history. */
    raw: string;
};

function parseToolCalls(text: string): ParsedTurn {
    const calls: ParsedToolCall[] = [];
    let preToolEnd = text.length;
    const openRe = new RegExp(TOOL_FENCE_OPEN_RE.source, "g");
    let openMatch: RegExpExecArray | null;
    while ((openMatch = openRe.exec(text)) !== null) {
        const openStart = openMatch.index;
        const openEnd = openMatch.index + openMatch[0].length;
        const tail = text.slice(openEnd);
        const closeMatch = TOOL_FENCE_CLOSE_RE.exec(tail);
        if (!closeMatch) break;
        const closeStart = openEnd + closeMatch.index;
        if (calls.length === 0) preToolEnd = openStart;
        const jsonStr = text.slice(openEnd, closeStart).trim();
        try {
            const parsed = JSON.parse(jsonStr) as {
                name?: string;
                input?: unknown;
            };
            if (parsed && typeof parsed.name === "string") {
                calls.push({
                    rawIndex: openStart,
                    name: parsed.name,
                    input:
                        parsed.input && typeof parsed.input === "object"
                            ? (parsed.input as Record<string, unknown>)
                            : {},
                });
            }
        } catch {
            // Malformed JSON — skip this fence. The model will see we
            // didn't acknowledge it on the next turn and can try again.
        }
        openRe.lastIndex = closeStart + closeMatch[0].length;
    }
    return {
        preToolText: text.slice(0, preToolEnd).trim(),
        toolCalls: calls,
        raw: text,
    };
}

function formatToolResultsForModel(results: NormalizedToolResult[]): string {
    const lines: string[] = ["TOOL RESULTS:"];
    for (const r of results) {
        lines.push(`- call_id ${r.tool_use_id}: ${r.content}`);
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Promised-action detection
// ---------------------------------------------------------------------------
// The mike-legal SOUL forbids "I'll do X next" without actually emitting
// the fence — that's the hallucinated-success failure mode the lawyer
// hates. This regex catches the most common forms.
const PROMISE_PATTERNS: RegExp[] = [
    // "I'll <verb>" / "I will <verb>" / "I will now <verb>".
    // Verbs broadly cover act/edit/lookup/research/load patterns —
    // anything where the agent says it's about to do something we'd
    // expect to be a tool call.
    /\bI(?:'ll|\s+will)(?:\s+(?:now|then|next))?\s+(?:call|use|invoke|execute|run|apply|issue|emit|generate|create|replicate|edit|update|fix|repurpose|replace|draft|adapt|read|scan|pull|fetch|get|retrieve|look\s+up|lookup|summarize|list|find|check|gather|load|grab|inspect|review|search|index)\b/i,
    // "calling the X tool now"
    /\bcalling\s+(?:the\s+)?\w+\s+tool\s+now\b/i,
    // "now <ing-verb>"
    /\bnow\s+(?:calling|executing|invoking|generating|applying|replicating|editing|reading|issuing|repurposing|drafting|pulling|fetching|retrieving|looking\s+up|gathering|searching)\b/i,
    // Filler phrases that delay action
    /\b(?:stand\s*by|one\s+moment|in\s+the\s+next\s+step|next\s+step|hang\s+on|hold\s+on|let\s+me\s+(?:check|see|look|grab|pull|fetch))\b/i,
    // "I am now <ing-verb>"
    /\bI\s+am\s+(?:now\s+)?(?:executing|invoking|generating|applying|preparing|going\s+to|pulling|fetching|reading|looking\s+up)\b/i,
    // "I am going to / about to <verb>"
    /\bI\s+am\s+(?:going\s+to|about\s+to)\s+\w+/i,
    // "Let me <verb>"
    /\bLet\s+me\s+(?:call|use|invoke|run|apply|read|pull|fetch|get|retrieve|look|check|grab|index|search|scan|summarize|list|find|gather|load|inspect|review)\b/i,
];

function promisesActionWithoutCall(text: string): boolean {
    if (!text || text.trim().length === 0) return false;
    return PROMISE_PATTERNS.some((re) => re.test(text));
}

const NUDGE_EXECUTE_NOW = [
    "EXECUTE NOW.",
    "",
    "Your previous turn described a future action but did not emit a",
    "TOOL_CALL fence. Per the mike-legal SOUL: you execute, you don't",
    "narrate. Two options:",
    "",
    "1. Emit the TOOL_CALL fence in THIS turn for the action you said",
    "   you would take.",
    "2. If you can't (wrong file type, missing data, schema mismatch),",
    "   say so in one sentence with the specific reason. Example:",
    "   \"Can't edit — this is a PDF, edit_document requires .docx.\"",
    "",
    "Do not promise to act \"next\" again. Either act in this turn or",
    "say why you can't.",
].join("\n");

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

function runOpenClawCli(args: string[], timeoutMs: number): Promise<{
    stdout: string;
    stderr: string;
    code: number;
}> {
    // Strip Mike-side OpenClaw env from the subprocess. We document
    // OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN in Mike's .env for
    // informational use, but the CLI itself treats those vars as URL
    // overrides and refuses to run without explicit --token. The CLI's
    // own ~/.openclaw/openclaw.json already has the gateway URL + token
    // wired in, so we let it use that config by removing the overrides.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OPENCLAW_GATEWAY_URL;
    delete env.OPENCLAW_GATEWAY_TOKEN;
    return new Promise((resolve, reject) => {
        const child = spawn(clawCli(), args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
                new Error(
                    `OpenClaw CLI timed out after ${timeoutMs}ms (args: ${args.slice(0, 2).join(" ")} ...)`,
                ),
            );
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? -1 });
        });
    });
}

async function callAgent(opts: {
    model: string;
    prompt: string;
}): Promise<AgentResult> {
    const sessionId = `mike-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const { provider, model } = resolveProviderModel(opts.model);

    const agentParams: Record<string, unknown> = {
        agentId: agentId(),
        sessionId,
        sessionKey: `agent=${agentId()}:session=${sessionId}`,
        message: opts.prompt,
        modelRun: true,
        promptMode: "none",
        idempotencyKey: sessionId,
    };
    if (provider) agentParams.provider = provider;
    if (model) agentParams.model = model;

    const args = [
        "gateway",
        "call",
        "agent",
        "--params",
        JSON.stringify(agentParams),
        "--expect-final",
        "--timeout",
        String(gatewayTimeoutMs()),
        "--json",
    ];

    const { stdout, stderr, code } = await runOpenClawCli(
        args,
        gatewayTimeoutMs() + 5000,
    );
    if (code !== 0) {
        const detail = (stderr || stdout).slice(0, 600).trim();
        throw new Error(
            `openclaw gateway call agent exited ${code}: ${detail || "no detail"}`,
        );
    }
    try {
        return JSON.parse(stdout) as AgentResult;
    } catch (err) {
        throw new Error(
            `openclaw gateway returned non-JSON output: ${stdout.slice(0, 300)} (${err instanceof Error ? err.message : err})`,
        );
    }
}

// ---------------------------------------------------------------------------
// Gateway plugin-tool invocation (for mike_* tools)
// ---------------------------------------------------------------------------

type PluginToolResult = {
    ok: boolean;
    toolName?: string;
    output?: {
        content?: { type?: string; text?: string }[];
        details?: unknown;
    };
    error?: { code?: string; message?: string };
    source?: string;
};

async function invokeGatewayTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    const cliArgs = [
        "gateway",
        "call",
        "tools.invoke",
        "--params",
        JSON.stringify({ name, args }),
        "--timeout",
        String(gatewayTimeoutMs()),
        "--json",
    ];
    const { stdout, stderr, code } = await runOpenClawCli(
        cliArgs,
        gatewayTimeoutMs() + 5000,
    );
    if (code !== 0) {
        throw new Error(
            `gateway tools.invoke ${name} exited ${code}: ${(stderr || stdout).slice(0, 400)}`,
        );
    }
    let parsed: PluginToolResult;
    try {
        parsed = JSON.parse(stdout) as PluginToolResult;
    } catch (err) {
        throw new Error(
            `gateway tools.invoke ${name} returned non-JSON: ${stdout.slice(0, 300)}`,
        );
    }
    if (!parsed.ok) {
        const msg = parsed.error?.message ?? "tool execution failed";
        throw new Error(`gateway tools.invoke ${name}: ${msg}`);
    }
    // Prefer the structured `details`; fall back to the text content blob.
    const details = parsed.output?.details;
    if (typeof details !== "undefined") {
        return JSON.stringify(details);
    }
    const textChunks = (parsed.output?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
    return textChunks.join("\n") || "{}";
}

function extractText(result: AgentResult): string {
    const payloads = result.result?.payloads ?? [];
    return payloads
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("");
}

// ---------------------------------------------------------------------------
// Fake-streaming
// ---------------------------------------------------------------------------
// The gateway returns the full text in one payload. To preserve Mike's
// SSE contract (which the frontend relies on for the typing animation),
// we chunk the text and yield to the event loop between chunks so the
// HTTP write side gets a chance to flush.

async function emitChunked(
    text: string,
    onContentDelta?: (delta: string) => void,
): Promise<void> {
    if (!onContentDelta || !text) {
        onContentDelta?.(text);
        return;
    }
    const CHUNK = 64;
    for (let i = 0; i < text.length; i += CHUNK) {
        onContentDelta(text.slice(i, i + CHUNK));
        // Yield so the SSE write actually flushes between chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

// ---------------------------------------------------------------------------
// Mock mode
// ---------------------------------------------------------------------------

async function mockOpenClawStream(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const lastUser = [...params.messages]
        .reverse()
        .find((m) => m.role === "user");
    const text = [
        "[OpenClaw mock mode]",
        "Mike is routed through the OpenClaw adapter, but the live gateway is disabled (OPENCLAW_USE_MOCK=true).",
        lastUser?.content
            ? `User request captured: ${lastUser.content.slice(0, 500)}`
            : "No user request was provided.",
        "",
        "Review status: needs human review",
    ].join("\n\n");
    await emitChunked(text, params.callbacks?.onContentDelta);
    return { fullText: text };
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export async function streamOpenClaw(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (process.env.OPENCLAW_USE_MOCK === "true") {
        return mockOpenClawStream(params);
    }

    try {
        if (params.tools && params.tools.length > 0) {
            return await streamOpenClawWithTools(params);
        }
        return await streamOpenClawTextOnly(params);
    } catch (err) {
        console.error("[openclaw adapter] gateway call failed:", err);
        if (process.env.OPENCLAW_FALLBACK_TO_MOCK === "true") {
            return mockOpenClawStream(params);
        }
        throw err;
    }
}

async function streamOpenClawTextOnly(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const prompt = flattenPrompt(params.systemPrompt, params.messages);
    const result = await callAgent({ model: params.model, prompt });
    const text = extractText(result);
    if (!text) {
        throw new Error(
            `OpenClaw agent returned no text (status=${result.status}, summary=${result.summary})`,
        );
    }
    await emitChunked(text, params.callbacks?.onContentDelta);
    return { fullText: text };
}

async function streamOpenClawWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const maxIter = params.maxIterations ?? 10;
    const tools = params.tools ?? [];
    const toolCatalog = buildToolCatalog(tools);

    // Conversation history we extend across iterations. We copy so we
    // never mutate the caller's array.
    const history: { role: "user" | "assistant"; content: string }[] =
        params.messages.map((m) => ({ role: m.role, content: m.content }));

    let fullText = "";
    // Tracks consecutive iterations where the model narrated a future
    // action ("I'll call X next", "standing by", "calling the tool now")
    // without emitting a tool fence. The mike-legal SOUL forbids this,
    // but Grok still slips sometimes — we nudge once, surface failure
    // after two consecutive nudges.
    let consecutivePromisedNoAction = 0;

    for (let iter = 0; iter < maxIter; iter++) {
        const prompt = flattenPrompt(
            params.systemPrompt,
            history,
            toolCatalog,
        );
        const result = await callAgent({ model: params.model, prompt });
        const raw = extractText(result);
        if (!raw) {
            throw new Error(
                `OpenClaw agent returned no text on iter ${iter} (status=${result.status}, summary=${result.summary})`,
            );
        }

        const parsed = parseToolCalls(raw);

        if (parsed.toolCalls.length === 0) {
            // No tool call this turn. Two cases:
            //   1. Genuine final answer — emit + return.
            //   2. The model PROMISED an action but didn't emit a fence.
            //      Nudge once. If it happens twice in a row, surface a
            //      real failure so the lawyer isn't left in a silent loop.
            if (promisesActionWithoutCall(raw)) {
                consecutivePromisedNoAction += 1;
                console.log(
                    `[openclaw enforcement] promise without action (#${consecutivePromisedNoAction}); raw=${JSON.stringify(raw.slice(0, 150))}`,
                );
                if (consecutivePromisedNoAction === 1) {
                    history.push({ role: "assistant", content: raw });
                    history.push({
                        role: "user",
                        content: NUDGE_EXECUTE_NOW,
                    });
                    continue; // re-enter loop, do NOT emit raw to user
                }
                // 2nd consecutive miss — surface a clear failure.
                const failureMsg =
                    "\n\n⚠ I described an action but couldn't execute it. " +
                    "This usually means the tool schema didn't fit (e.g. " +
                    "trying to edit a PDF — only .docx is editable) or the " +
                    "request is ambiguous. Tell me what you want me to do " +
                    "in a different way, or switch to Claude Opus for edits.";
                await emitChunked(
                    raw + failureMsg,
                    params.callbacks?.onContentDelta,
                );
                fullText += raw + failureMsg;
                return { fullText };
            }
            // Genuine final answer.
            await emitChunked(raw, params.callbacks?.onContentDelta);
            fullText += raw;
            return { fullText };
        }
        // Got a tool call — reset the no-action counter.
        consecutivePromisedNoAction = 0;

        // Pre-tool text — let the UI see the model's reasoning before
        // tool calls run.
        if (parsed.preToolText) {
            await emitChunked(
                parsed.preToolText,
                params.callbacks?.onContentDelta,
            );
            fullText += parsed.preToolText;
        }

        // Normalise tool calls, assign ids, fire start callbacks.
        const normalised: NormalizedToolCall[] = parsed.toolCalls.map(
            (c, idx) => ({
                id: `${c.name}-${iter}-${idx}-${randomUUID().slice(0, 6)}`,
                name: c.name,
                input: c.input,
            }),
        );
        for (const call of normalised) {
            params.callbacks?.onToolCallStart?.(call);
        }

        // Split: mike_* tools run through the gateway plugin; everything
        // else runs through Mike's in-process tool dispatcher.
        const gatewayCalls = normalised.filter((c) =>
            c.name.startsWith(MIKE_TOOL_PREFIX),
        );
        const inProcessCalls = normalised.filter(
            (c) => !c.name.startsWith(MIKE_TOOL_PREFIX),
        );

        const results: NormalizedToolResult[] = [];

        // Gateway-routed tools, in parallel.
        const gatewayPromises = gatewayCalls.map(async (call) => {
            try {
                const content = await invokeGatewayTool(call.name, call.input);
                return { tool_use_id: call.id, content };
            } catch (err) {
                return {
                    tool_use_id: call.id,
                    content: JSON.stringify({
                        error:
                            err instanceof Error ? err.message : String(err),
                    }),
                };
            }
        });
        const gatewayResults = await Promise.all(gatewayPromises);
        results.push(...gatewayResults);

        // In-process tools via the caller's runTools.
        if (inProcessCalls.length > 0) {
            if (!params.runTools) {
                for (const call of inProcessCalls) {
                    results.push({
                        tool_use_id: call.id,
                        content: JSON.stringify({
                            error:
                                "no in-process tool runner provided; this tool cannot execute on the openclaw provider",
                            tool: call.name,
                        }),
                    });
                }
            } else {
                try {
                    const localResults = await params.runTools(inProcessCalls);
                    results.push(...localResults);
                } catch (err) {
                    for (const call of inProcessCalls) {
                        results.push({
                            tool_use_id: call.id,
                            content: JSON.stringify({
                                error:
                                    err instanceof Error
                                        ? err.message
                                        : String(err),
                                tool: call.name,
                            }),
                        });
                    }
                }
            }
        }

        // Re-order results to match the original call order so the model
        // sees a coherent transcript.
        const resultsById = new Map(
            results.map((r) => [r.tool_use_id, r] as const),
        );
        const ordered = normalised
            .map((c) => resultsById.get(c.id))
            .filter((r): r is NormalizedToolResult => Boolean(r));

        // Append to history: the assistant's raw turn (including the
        // fences, so the model sees its own call when it gets re-prompted),
        // then a user turn with the formatted results.
        history.push({ role: "assistant", content: raw });
        history.push({
            role: "user",
            content: formatToolResultsForModel(ordered),
        });
    }

    // Ran out of iterations without a final answer. Surface that to the
    // user instead of silently truncating.
    const exhaustedMsg =
        "[openclaw] tool loop hit max iterations without a final answer";
    params.callbacks?.onContentDelta?.(exhaustedMsg);
    fullText += exhaustedMsg;
    return { fullText };
}

export async function completeOpenClawText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
}): Promise<string> {
    const result = await streamOpenClaw({
        model: params.model,
        systemPrompt: params.systemPrompt ?? "",
        messages: [{ role: "user", content: params.user }],
        maxIterations: 1,
    });
    return result.fullText;
}
