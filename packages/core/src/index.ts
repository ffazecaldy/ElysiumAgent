/**
 * @elysium/core — public API surface.
 * Minimal core: agent loop, tool system, session & state, orchestration
 * primitives (depth <= 2), streaming quality gate, multi-provider LLM
 * interface, event/telemetry bus.
 */

// ---- FROZEN SHARED TYPES ----
export * from "./types/content";
export * from "./types/messages";
export * from "./types/provider";
export * from "./types/events";
export * from "./types/tools";
export * from "./types/session";
export * from "./types/quality";
export * from "./types/orchestration";
export * from "./types/errors";

// ---- IMPLEMENTATION MODULES ----
// Agent loop variants (winner will be promoted to the canonical path in Phase 2 review)
export * from "./agent/agent";
// Orchestration variant (canonical executor currently under variant review)
export * from "./orchestration/orchestrator";
// Providers
export * from "./providers/mock-provider";
export * from "./providers/registry";
export * from "./providers/openai-compatible";
// Tool system
export * from "./tools/registry";
export * from "./tools/policy";
export * from "./tools/builtins/read";
export * from "./tools/builtins/write";
export * from "./tools/builtins/edit";
export * from "./tools/builtins/bash";
// Session & state
export * from "./session/session";
// Event/telemetry bus
export * from "./events/bus";
// Quality gate
export * from "./quality/gate";
export {
  riskScore,
} from "./quality/risk-score";
export type { RiskInput, RiskScore } from "./quality/risk-score";
