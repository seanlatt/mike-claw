// ---------------------------------------------------------------------------
// Action-receipt verification — the "you cannot claim completion without
// proof" guardrail.
// ---------------------------------------------------------------------------
//
// The model sometimes narrates a successful action ("I edited the NDA",
// "I have repurposed the document") without actually emitting the tool
// call that would do it. The enforcement loop in openclaw.ts catches
// FUTURE-tense promises ("I'll do X next"). This module catches the
// other half: PAST-tense claims of completion that have no matching
// event in the assistant's events list.
//
// Usage: at the end of a chat turn, call `verifyActionReceipts(fullText,
// events)`. If it returns a no_action_warning event, append it to events
// before persisting the assistant message + write it to the SSE stream
// so the UI surfaces the failure loudly.

export type MutationIntent =
    | "edit"
    | "create"
    | "replicate"
    | "generate"
    | "draft"
    | "update"
    | "repurpose";

export type NoActionWarning = {
    type: "no_action_warning";
    intent: MutationIntent;
    /** Short snippet of the claim that triggered the warning. */
    claim_excerpt: string;
    /** Receipt event types we looked for. */
    expected_receipts: string[];
    /** Human-readable summary the UI can render. */
    message: string;
};

/**
 * Past-tense / present-perfect mutation claims. Each pattern maps to an
 * intent. Future-tense ("I'll edit...") is intentionally NOT here —
 * those are caught upstream by the enforcement loop in openclaw.ts.
 */
const CLAIM_PATTERNS: { re: RegExp; intent: MutationIntent }[] = [
    // "I edited / I have edited / I've edited / Edited the doc / etc."
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?edited|I\s+made\s+(?:the\s+)?edits?|Edited\s+the\s+(?:doc|document|file)|applied\s+the\s+edits?)\b/i,
        intent: "edit",
    },
    // "I created / I generated / Generated the doc" — generous pattern.
    // We accept any past-tense create-verb followed within 40 chars by
    // a document-y noun. The 40-char window lets adjectives, commas,
    // and filename fragments sit between the verb and the noun
    // ("created a clean, editable .docx version").
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?(?:created|generated|produced|made|built)|(?:Created|Generated|Produced))[\s\S]{1,40}?(?:doc|document|file|word|docx|memo|draft|letter|version|copy|agreement|nda|template|contract|\.docx)/i,
        intent: "create",
    },
    // "I replicated / I copied / I duplicated"
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?(?:replicated|copied|duplicated|cloned)|(?:Replicated|Copied|Duplicated)\s+the)\b/i,
        intent: "replicate",
    },
    // "I generated the docx" — covered above by "create" but also explicit:
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?generated|generated\s+a\s+(?:clean,\s+)?editable)\b/i,
        intent: "generate",
    },
    // "I drafted / I've drafted"
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?drafted|Drafted\s+(?:the|a|an|your))\b/i,
        intent: "draft",
    },
    // "I updated / Updated the doc"
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?updated|Updated\s+the\s+(?:doc|document|file|signature|party)|the\s+document\s+has\s+been\s+updated)\b/i,
        intent: "update",
    },
    // "I repurposed / I've repurposed / repurposed the X for Y"
    {
        re: /\b(?:I\s+(?:have\s+|'ve\s+)?repurposed|Repurposed\s+(?:the|a|an|your))\b/i,
        intent: "repurpose",
    },
    // "X has been successfully generated/created/updated"
    {
        re: /\b(?:has\s+been\s+(?:successfully\s+)?(?:generated|created|edited|updated|replicated|repurposed|drafted))\b/i,
        intent: "create",
    },
];

/**
 * Which event types satisfy each intent. Intentionally permissive — any
 * doc_* mutation event counts for any mutation intent because the model
 * sometimes uses a different verb than the tool name.
 */
const ANY_MUTATION_RECEIPT = [
    "doc_edited",
    "doc_created",
    "doc_replicated",
    "doc_generated",
    "workflow_applied",
] as const;

const RECEIPTS_BY_INTENT: Record<MutationIntent, readonly string[]> = {
    edit: ANY_MUTATION_RECEIPT,
    create: ANY_MUTATION_RECEIPT,
    replicate: ANY_MUTATION_RECEIPT,
    generate: ANY_MUTATION_RECEIPT,
    draft: ANY_MUTATION_RECEIPT,
    update: ANY_MUTATION_RECEIPT,
    repurpose: ANY_MUTATION_RECEIPT,
};

export function detectMutationIntent(
    text: string,
): { intent: MutationIntent; excerpt: string } | null {
    if (!text) return null;
    for (const { re, intent } of CLAIM_PATTERNS) {
        const m = re.exec(text);
        if (m) {
            // Capture a short window around the match for the warning.
            const idx = m.index;
            const start = Math.max(0, idx - 30);
            const end = Math.min(text.length, idx + m[0].length + 60);
            return {
                intent,
                excerpt: text.slice(start, end).trim(),
            };
        }
    }
    return null;
}

export function hasMatchingReceipt(
    events: { type?: string }[],
    intent: MutationIntent,
): boolean {
    const accepted = new Set(RECEIPTS_BY_INTENT[intent]);
    return events.some((e) => e.type && accepted.has(e.type));
}

/**
 * Top-level check used by chat routes. Returns null when everything's
 * fine (either no mutation claim, OR a matching receipt is present).
 * Returns a no_action_warning event to append when the model claimed
 * a mutation without proof.
 */
export function verifyActionReceipts(
    fullText: string,
    events: { type?: string }[],
): NoActionWarning | null {
    const detected = detectMutationIntent(fullText);
    if (!detected) return null;
    if (hasMatchingReceipt(events, detected.intent)) return null;

    const expected = Array.from(RECEIPTS_BY_INTENT[detected.intent]);
    return {
        type: "no_action_warning",
        intent: detected.intent,
        claim_excerpt: detected.excerpt,
        expected_receipts: expected,
        message: [
            `The agent claimed it ${pastTense(detected.intent)} a document, but no ${expected.join(" / ")} event was recorded.`,
            "Nothing was actually changed. The agent may have hallucinated the action.",
            "Try rephrasing more specifically, or switch the model to Claude Opus for edit operations (Mike's model picker, top-right of the chat).",
        ].join(" "),
    };
}

function pastTense(intent: MutationIntent): string {
    switch (intent) {
        case "edit":
            return "edited";
        case "create":
            return "created";
        case "replicate":
            return "replicated";
        case "generate":
            return "generated";
        case "draft":
            return "drafted";
        case "update":
            return "updated";
        case "repurpose":
            return "repurposed";
    }
}
