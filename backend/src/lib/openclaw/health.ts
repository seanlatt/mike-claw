import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// OpenClaw gateway health probe
// ---------------------------------------------------------------------------
// We rely on the local `openclaw` CLI to do the WS handshake. That keeps
// Mike out of the gateway auth/token plumbing — the CLI reads
// ~/.openclaw/openclaw.json automatically. The trade-off is ~1s per probe.

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18789";
const HEALTH_TIMEOUT_MS = 5_000;

export type OpenClawHealth = {
    ok: boolean;
    gatewayUrl: string;
    model: string;
    mockMode: boolean;
    detail?: string;
    gateway?: {
        version?: string;
        plugins?: string[];
        defaultModel?: string;
    };
};

function clawCli(): string {
    // OPENCLAW_CLI is reserved by the gateway launchd service (set to "1"
    // as a marker). Use OPENCLAW_CLI_PATH to override the binary path.
    return process.env.OPENCLAW_CLI_PATH?.trim() || "openclaw";
}

function configuredGatewayUrl(): string {
    return (process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(
        /\/+$/,
        "",
    );
}

function configuredDefaultModel(): string {
    // What Mike will *ask the gateway for* by default. We don't pin this in
    // the gateway itself — the gateway picks the configured default unless
    // the caller overrides provider/model.
    return process.env.OPENCLAW_MODEL?.trim() || "openclaw/default";
}

function runCli(args: string[], timeoutMs: number): Promise<{
    stdout: string;
    stderr: string;
    code: number;
}> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OPENCLAW_GATEWAY_URL;
    delete env.OPENCLAW_GATEWAY_TOKEN;
    return new Promise((resolve) => {
        const child = spawn(clawCli(), args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ stdout, stderr: stderr + "\n[timeout]", code: -1 });
        }, timeoutMs);
        child.stdout.on("data", (c) => (stdout += c.toString()));
        child.stderr.on("data", (c) => (stderr += c.toString()));
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ stdout, stderr: err.message, code: -1 });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? -1 });
        });
    });
}

export async function checkOpenClawHealth(): Promise<OpenClawHealth> {
    const gatewayUrl = configuredGatewayUrl();
    const model = configuredDefaultModel();
    const mockMode = process.env.OPENCLAW_USE_MOCK === "true";

    if (mockMode) {
        return {
            ok: true,
            gatewayUrl,
            model,
            mockMode,
            detail: "OpenClaw mock mode enabled (OPENCLAW_USE_MOCK=true)",
        };
    }

    const { stdout, stderr, code } = await runCli(
        ["gateway", "call", "health", "--json", "--timeout", "3000"],
        HEALTH_TIMEOUT_MS,
    );

    if (code !== 0) {
        return {
            ok: false,
            gatewayUrl,
            model,
            mockMode,
            detail:
                (stderr || stdout).slice(0, 400).trim() ||
                "gateway call exited non-zero",
        };
    }

    try {
        const parsed = JSON.parse(stdout) as {
            ok?: boolean;
            plugins?: { loaded?: string[] };
            modelPricing?: { state?: string };
        };
        return {
            ok: parsed.ok === true,
            gatewayUrl,
            model,
            mockMode,
            detail: parsed.ok ? "gateway healthy" : "gateway reported not-ok",
            gateway: {
                plugins: parsed.plugins?.loaded ?? [],
            },
        };
    } catch (err) {
        return {
            ok: false,
            gatewayUrl,
            model,
            mockMode,
            detail: `gateway returned non-JSON: ${stdout.slice(0, 200)}`,
        };
    }
}
