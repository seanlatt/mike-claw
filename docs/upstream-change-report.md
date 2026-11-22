# Upstream Change Report: open-legal-products/mike

**Date**: November 22, 2026  
**Comparison**: mike-claw fork vs upstream Mike main  
**Branch Point**: commit d969096 ("Add local repo contents"), April 29, 2026  
**Commits Since Branch**: 1,809  

---

## Executive Summary

Upstream Mike has evolved significantly since mike-claw forked in late April 2026. The most impactful changes fall into four categories:

1. **Backend modular architecture overhaul** (the biggest change)
2. **AI SDK v7 migration** with multi-provider support
3. **Vercel deployment support** including one-click deployment
4. **Worker threads for background processing**

None of these changes break the OpenClaw integration pattern, but they require adapting OpenClaw code to the new module structure.

---

## 1. Architecture Changes

### Modular Backend Structure

Upstream reorganized the backend from a flat `lib/` and `routes/` layout to a domain-driven module system:

```
backend/src/
  modules/
    approval/        # document approval workflows
    assistant/       # chat assistant routes
    audit/           # audit logging
    auth/            # authentication middleware
    byok/            # bring your own key
    chat/            # chat sessions
    connectors/      # external connectors
    documents/       # document management
    folders/         # folder organization
    health/          # health checks
    llm/             # LLM integrations
    mcp/             # MCP server support
    memory/          # agent memory
    playbooks/       # playbooks feature
    projects/        # project management
    settings/        # user settings
    storage/         # file storage
    suggestions/     # AI suggestions
    tabular/         # tabular review
    tasks/           # background tasks
    users/           # user management
    workflows/       # workflow engine
  application/       # cross-domain orchestration
  lib/               # shared kernel (pure utilities)
```

Each module now follows a convention:
- `<domain>.routes.ts` - Express router
- `<domain>.service.ts` - module facade (single import point)
- Internal helpers stay private within the module

**Impact on OpenClaw**: The OpenClaw routes and lib files needed to be adapted to this structure. We created `modules/openclaw/` with `openclaw.routes.ts` and `openclaw.service.ts`.

### Worker Threads for Background Processing

The backend now uses Node.js worker threads (`worker_threads`) for heavy operations:

```typescript
// backend/src/index.ts
import { isMainThread, parentPort, workerData } from "worker_threads";
```

This enables parallel processing without blocking the main event loop. The pattern is used for:
- Document text extraction
- PDF parsing
- Heavy LLM operations

**Impact on OpenClaw**: The background ingest (`kickoffBackgroundIngest`) already uses fire-and-forget async patterns, which remain compatible.

---

## 2. AI SDK and Provider Changes

### Vercel AI SDK v7

Upstream migrated from AI SDK v4 to v7:

```json
{
  "ai": "^7.0.173",
  "@ai-sdk/anthropic": "^4.0.105",
  "@ai-sdk/openai": "^4.0.77",
  "@ai-sdk/google": "^4.0.121",
  "@ai-sdk/xai": "^5.0.46"
}
```

Key changes:
- `streamChatWithTools` API signature updated
- `enableThinking` option removed (Claude thinking is now automatic)
- Multi-provider support with provider-prefixed model names

### Multi-Provider Model Selection

Models are now referenced with provider prefixes:

- `anthropic/claude-sonnet-5-5`
- `openai/gpt-4o`
- `google/gemini-2.0-flash`
- `xai/grok-2`

The deprecated `DEFAULT_MAIN_MODEL` constant was replaced with per-context model resolution via `resolveModel()`.

**Impact on OpenClaw**: OpenClaw code updated to use hardcoded `"claude-sonnet-5-5"` instead of the removed constant. The gateway's own model selection remains independent.

### Provider Retention Flags

New feature allowing operators to request that providers not retain or train on prompts:

```typescript
feat(llm): let an operator turn the provider retention requests off
feat(llm): ask providers not to keep or train on lawyers' prompts
```

This is particularly relevant for legal workloads where data confidentiality matters.

---

## 3. Deployment and Infrastructure

### Vercel One-Click Deployment

Major new capability:

```
feat: deploy the full stack on Vercel (prototype)
docs: deploy on Vercel with a Marketplace Supabase project
```

The `Deploy on Vercel` button in the README now provisions:
- Backend API (Vercel Functions)
- Frontend (Next.js on Vercel)
- Supabase via Vercel Marketplace

This simplifies deployment significantly but requires the new environment structure.

### First-Run Setup Screen

New onboarding flow:

```
feat: first-run setup screen and configured-only sign-in providers
```

When deployed fresh, Mike now shows a setup wizard for:
- Admin account creation
- Sign-in provider configuration
- API key setup

### Express v5

Backend upgraded from Express v4 to v5:

```json
{
  "express": "^5.3.0"
}
```

Key breaking changes:
- `req.params` can be `string | string[]` (requires validation)
- Promise rejection handling improved
- Path-to-regexp v8 patterns

**Impact on OpenClaw**: Route handlers updated to validate `req.params.taskId` for the new type signature.

---

## 4. Database and Schema Changes

### New Migration System

Migrations now use timestamped filenames (`YYYYMMDD_NN_description.sql`) and are tracked in `schema.sql`. The test suite validates:
- Every migration file is listed in `schema.sql`
- References to migrations point to existing files

### New Tables Since Fork

Notable schema additions:
- `tabular_cache_revisions` - caching for tabular review
- `playbook_review_publication` - playbook publishing
- Document text search per-version

### OpenClaw Tables (new)

This merge adds:
- `openclaw_tasks` - task envelopes with approval state
- `openclaw_audit_events` - append-only audit log

Migration: `20261122_01_openclaw_audit.sql`

---

## 5. Feature Additions

### Legal Data Hunter MCP Sources

```
feat(frontend): add LDH preset and embedded legal source citations
```

Integration with Legal Data Hunter for case law and statute retrieval.

### Tool Activity Counts

```
feat: central backend logger with opt-in Sentry logs and metrics, and tool activity counts
```

Telemetry for tracking tool usage patterns.

### Settings Search

```
feat(settings): add a search box over settings sections
```

Quality-of-life improvement for the settings UI.

### Script Sandbox

```
feat: add run_script for sandboxed lookups across many documents
```

Safe execution environment for custom document processing scripts.

---

## 6. Security and Privacy

### Provider Error Redaction

```
fix(logging): stop provider errors printing prompts and responses to stdout
fix(logging): name redacted provider errors and redact job failure text
```

Sensitive content is now redacted from logs.

### API Key Security

```
fix: secure user API keys
```

Improved handling of user-provided API keys.

---

## 7. License

No license change. Upstream remains **AGPL-3.0**, which requires:
- Source disclosure for network services
- Derivative works under the same license
- Copyright and license notices preserved

mike-claw inherits these obligations.

---

## 8. Breaking Changes Summary

| Change | Impact | Mitigation |
|--------|--------|------------|
| Module architecture | Routes must live in `modules/<domain>/` | Created `modules/openclaw/` |
| `DEFAULT_MAIN_MODEL` removed | Cannot import from `lib/llm` | Hardcode `"claude-sonnet-5-5"` |
| `enableThinking` option removed | Breaks `streamChatWithTools` calls | Remove the option |
| `extractPdfText` moved | Import path changed | Import from `lib/pdfText` |
| Express v5 params | `req.params.*` can be array | Validate with `Array.isArray()` |
| Migration ledger | New migrations must be in `schema.sql` | Added `20261122_01_openclaw_audit.sql` |

---

## 9. Recommendations

1. **Keep synced with upstream** by periodically rebasing. The modular architecture makes this easier since OpenClaw is now isolated in its own module.

2. **Consider moving OpenClaw lib files** into `modules/openclaw/` entirely. Currently they remain in `lib/openclaw/` for minimal diff, but upstream convention would put them inside the module.

3. **Watch for AI SDK updates**. Upstream is actively tracking Vercel AI SDK releases; major version bumps may require attention.

4. **Test Vercel deployment path**. The one-click deployment may need adjustments for OpenClaw's gateway dependency.
