/**
 * OpenClaw module facade.
 *
 * This file is the single import point for external consumers. Internal
 * helpers (the lib/openclaw/* files) are not re-exported; only the
 * publicly useful bits appear here.
 */

export { openclawRouter } from "./openclaw.routes";

// Re-export types consumers might need
export type { IngestOptions } from "../../lib/openclaw/ingest";

// Re-export helpers intended for other modules (e.g., chat integration)
export {
  kickoffBackgroundIngest,
} from "../../lib/openclaw/ingest";

export {
  checkOpenClawHealth,
} from "../../lib/openclaw/health";

export {
  createOpenClawTask,
  loadMikeSkillBody,
} from "../../lib/openclaw/tasks";
