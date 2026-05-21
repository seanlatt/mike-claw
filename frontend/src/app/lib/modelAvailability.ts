import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini";
export type RuntimeProvider = ModelProvider | "openclaw";

export function getModelProvider(modelId: string): RuntimeProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    if (model.group === "OpenClaw") return "openclaw";
    return model.group === "Anthropic" ? "claude" : "gemini";
}

export function isModelAvailable(
    modelId: string,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null },
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "openclaw") return true;
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(
    provider: RuntimeProvider,
    apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null },
): boolean {
    if (provider === "openclaw") return true;
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: RuntimeProvider): string {
    if (provider === "openclaw") return "OpenClaw";
    return provider === "claude" ? "Anthropic (Claude)" : "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): RuntimeProvider {
    if (group === "OpenClaw") return "openclaw";
    return group === "Anthropic" ? "claude" : "gemini";
}
