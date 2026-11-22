import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export type OpenClawTaskKind =
    | "intake_triage"
    | "document_review"
    | "legal_research"
    | "drafting"
    | "timeline"
    | "tabular_review";

export type OpenClawTaskInput = {
    kind: OpenClawTaskKind;
    jurisdiction?: string | null;
    practice_area?: string | null;
    input_documents?: string[];
    instructions?: string | null;
    approval_required?: boolean;
};

export type OpenClawTaskEnvelope = OpenClawTaskInput & {
    task_id: string;
    matter_id?: string | null;
    project_id?: string | null;
    user_id: string;
    status: "draft" | "running" | "needs_review" | "approved" | "rejected";
};

export function createOpenClawTask(input: {
    userId: string;
    projectId?: string | null;
    task?: Partial<OpenClawTaskInput> | null;
}): OpenClawTaskEnvelope | null {
    if (!input.task?.kind) return null;
    return {
        task_id: `oct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        user_id: input.userId,
        matter_id: input.projectId ?? null,
        project_id: input.projectId ?? null,
        kind: input.task.kind,
        jurisdiction: input.task.jurisdiction ?? null,
        practice_area: input.task.practice_area ?? null,
        input_documents: input.task.input_documents ?? [],
        instructions: input.task.instructions ?? null,
        approval_required: input.task.approval_required ?? true,
        status: "running",
    };
}

// ---------------------------------------------------------------------------
// mike-legal skill loading
// ---------------------------------------------------------------------------
// The authoritative version of Mike's task contract (output templates,
// approval rules, citation discipline) lives in the OpenClaw workspace
// skill at ~/clawdbot/skills/mike-legal/SKILL.md. That file is the source
// of truth for Mike, Telegram, and any other OpenClaw caller — Mike's
// backend reads it at runtime and prepends it as the system prompt so the
// task envelope and the contract stay in sync without duplicated copies.
//
// If the skill file isn't found, we fall back to a short built-in note so
// the system still works (degraded — model won't follow the strict
// template).

const SKILL_SEARCH_PATHS: string[] = [
    resolve(homedir(), "clawdbot", "skills", "mike-legal", "SKILL.md"),
    "/Users/slatt/clawdbot/skills/mike-legal/SKILL.md",
];

const FALLBACK_SKILL_BODY = [
    "# mike-legal (fallback)",
    "",
    "The OpenClaw workspace skill at clawdbot/skills/mike-legal/SKILL.md was",
    "not loadable. Operating from a minimal built-in contract:",
    "",
    "- This is legal work, not casual chat. Output is always a draft.",
    "- Anything external-facing requires human approval — do not self-approve.",
    "- For document review, produce: summary, parties, dates, obligations,",
    "  risks, missing facts, recommended actions, citations, confidence.",
    "- End with: Review status: needs human review",
].join("\n");

let cachedSkillBody: string | null = null;

export function loadMikeSkillBody(): string {
    if (cachedSkillBody !== null) return cachedSkillBody;
    const overridePath = process.env.MIKE_SKILL_PATH?.trim();
    const candidates = overridePath
        ? [overridePath, ...SKILL_SEARCH_PATHS]
        : SKILL_SEARCH_PATHS;
    for (const path of candidates) {
        try {
            const body = readFileSync(path, "utf8");
            if (body.length > 0) {
                cachedSkillBody = body;
                return body;
            }
        } catch {
            /* try next */
        }
    }
    console.warn(
        "[mike-legal] skill file not found in any of:",
        candidates.join(", "),
        "— using fallback contract",
    );
    cachedSkillBody = FALLBACK_SKILL_BODY;
    return FALLBACK_SKILL_BODY;
}

export function buildOpenClawTaskSystemPrompt(
    task: OpenClawTaskEnvelope | null,
): string {
    const skillBody = loadMikeSkillBody();
    if (!task) return skillBody;

    const envelope = [
        "",
        "---",
        "",
        "OPENCLAW TASK MODE:",
        `task_id: ${task.task_id}`,
        `kind: ${task.kind}`,
        `jurisdiction: ${task.jurisdiction || "unspecified"}`,
        `practice_area: ${task.practice_area || "unspecified"}`,
        `approval_required: ${task.approval_required !== false}`,
    ];

    if (task.instructions) {
        envelope.push("", "USER TASK INSTRUCTIONS:", task.instructions);
    }
    if (task.input_documents?.length) {
        envelope.push(
            "",
            "TASK INPUT DOCUMENT IDS:",
            task.input_documents.join(", "),
        );
    }

    return skillBody + "\n" + envelope.join("\n");
}
