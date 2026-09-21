/**
 * packages/cli/src/adaptive/engine.ts — the Adaptive Strategy Layer seam.
 *
 * / Motore adattivo: pattern → reliability gate → strategy → decisione.
 *
 * PIPELINE (no shortcuts): the learning profile feeds pattern candidates,
 * the deterministic reliability gate approves them, approved strategies are
 * matched against the current run and produce an explicit StrategyDecision.
 * Mode default is disabled; only `apply` mutates future behavior, and even
 * then only by ADDING verification (closed action vocabulary — bypassing
 * security policy is not expressible).
 */

import type { AgentPerformanceProfile, LearnedPattern } from "../learning";
import { evaluateReliability } from "./policy";
import {
  STRATEGY_STORE_VERSION,
  loadStrategyStore,
  saveStrategyStore,
  upsertStrategy,
} from "./store";
import {
  type AdaptiveMode,
  DEFAULT_RELIABILITY_POLICY,
  type PatternCandidate,
  type Strategy,
  type StrategyDecision,
  type StrategyReliabilityPolicy,
  type StrategyStoreShape,
} from "./types";

/** Strategy ids derived from patterns (deterministic, versioned, bounded). */
function strategyIdFor(pattern: string): string {
  const slug = pattern
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return `strategy-${slug}-v1`;
}

/**
 * Detect strategy candidates from the learning profile. Only the FIRST
 * shipped family is derived here (rollback / postcondition false-success +
 * tool-attach failures) — deliberately small, safe, observable.
 *
 * Conflict rate for a failure pattern = PASS share inside the same bucket
 * (from the profile's task patterns when available), NOT `1 - rate` (the
 * pattern rate is a share of the failure bucket, not a success ratio).
 */
export function detectCandidates(profile: AgentPerformanceProfile): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  const passShareByClass = new Map<string, number>();
  for (const p of profile.taskPatterns) {
    const klass = p.key.replace(/^task-class:/, "");
    const passCount = (p.summary.match(/(\d+) PASS/) ?? [])[1];
    if (passCount !== undefined && p.sampleCount > 0) {
      passShareByClass.set(klass, Number(passCount) / p.sampleCount);
    }
  }
  for (const p of profile.failurePatterns) {
    const conflict = [...passShareByClass.values()];
    const conflictRate =
      conflict.length > 0 ? conflict.reduce((a, b) => a + b, 0) / conflict.length : 0;
    candidates.push({
      pattern: p.key,
      sampleCount: p.sampleCount,
      patternRate: p.rate,
      conflictRate,
      evidenceCompleteness: profile.metrics.evidenceCompleteness,
      meanConfidence: profile.metrics.averageConfidence,
    });
  }
  return candidates;
}

const ACTION_BY_PATTERN: Array<{
  test: RegExp;
  action: Strategy["action"];
}> = [
  {
    test: /rollback|restored-workspace/i,
    action: {
      kind: "ADD_POSTCONDITION_VERIFICATION",
      postcondition: "rollback-restored-workspace",
      note: "history shows rollback false-successes — verify workspace restoration",
    },
  },
  {
    test: /^tool:(.+)$/i,
    action: {
      kind: "SUGGEST_EXTRA_CHECK",
      note: "history shows repeated failures with this tool — add an extra check",
    },
  },
  {
    test: /exit-code|postcondition/i,
    action: {
      kind: "REQUIRE_EVIDENCE",
      note: "history shows postcondition contradictions — require explicit evidence",
    },
  },
];

function actionFor(pattern: string): Strategy["action"] | null {
  for (const entry of ACTION_BY_PATTERN) {
    if (entry.test.test(pattern)) return { ...entry.action };
  }
  return null;
}

/** Validate a strategy against the closed safe action vocabulary. */
export function isValidStrategyShape(strategy: Strategy): boolean {
  const SAFE_ACTIONS = new Set([
    "ADD_POSTCONDITION_VERIFICATION",
    "SUGGEST_EXTRA_CHECK",
    "REQUIRE_EVIDENCE",
  ]);
  if (!SAFE_ACTIONS.has(strategy.action.kind)) return false;
  if (strategy.action.kind === "ADD_POSTCONDITION_VERIFICATION") {
    return (
      typeof strategy.action.postcondition === "string" && strategy.action.postcondition.length > 0
    );
  }
  return true;
}

export interface AdaptiveEngineOptions {
  /** Storage root (strategy store lives under `<root>/.elysium/learning/`). */
  root: string;
  policy?: StrategyReliabilityPolicy;
}

export interface AdaptiveEngine {
  /** Current mode from the persisted store. Default: disabled. */
  mode(): AdaptiveMode;
  /** Set the mode (persisted). Nothing runs in disabled. */
  setMode(mode: AdaptiveMode): void;
  /**
   * Full pipeline pass: profile → candidates → reliability gate → strategy
   * upsert (approve/reject/refresh). Returns the audit trail entries.
   */
  learnFrom(profile: AgentPerformanceProfile): StrategyDecision[];
  /** Strategies matching a run (enabled, valid, fresh) — for consumers. */
  applicableStrategies(now?: number): Strategy[];
  /** The explicit decision record for the current run context. */
  decide(pattern: string, mode?: AdaptiveMode): StrategyDecision | null;
  /** Raw store access (display/audit). */
  store(): StrategyStoreShape;
  /** Drop stale/invalid strategies past policy age (history preserved by caller). */
  refresh(now?: number): StrategyDecision[];
}

export function createAdaptiveEngine(opts: AdaptiveEngineOptions): AdaptiveEngine {
  const policy = opts.policy ?? DEFAULT_RELIABILITY_POLICY;
  const dir = opts.root.replace(/\\/g, "/").includes(".elysium/learning")
    ? opts.root.replace(/\\/g, "/")
    : `${opts.root.replace(/\\/g, "/")}/.elysium/learning`;

  return {
    mode(): AdaptiveMode {
      return loadStrategyStore(dir).mode;
    },

    setMode(mode: AdaptiveMode): void {
      const store = loadStrategyStore(dir);
      saveStrategyStore(dir, { ...store, mode });
    },

    learnFrom(profile: AgentPerformanceProfile): StrategyDecision[] {
      const decisions: StrategyDecision[] = [];
      const now = new Date().toISOString();
      const store = loadStrategyStore(dir);
      let next = store;
      for (const candidate of detectCandidates(profile)) {
        const gate = evaluateReliability(candidate, policy);
        const id = strategyIdFor(candidate.pattern);
        if (!gate.reliable) {
          decisions.push({
            strategyId: id,
            triggerPattern: candidate.pattern,
            reliability: gate.score,
            mode: store.mode,
            action: { kind: "SUGGEST_EXTRA_CHECK" },
            applied: false,
            reason: `reliability gate rejected: ${gate.reasons.join("; ")}`,
            evidence: { sampleCount: candidate.sampleCount, patternRate: candidate.patternRate },
            at: now,
          });
          continue;
        }
        const action = actionFor(candidate.pattern);
        if (action === null) {
          decisions.push({
            strategyId: id,
            triggerPattern: candidate.pattern,
            reliability: gate.score,
            mode: store.mode,
            action: { kind: "SUGGEST_EXTRA_CHECK" },
            applied: false,
            reason: "no safe action mapped for this pattern (family not implemented)",
            evidence: { sampleCount: candidate.sampleCount, patternRate: candidate.patternRate },
            at: now,
          });
          continue;
        }
        const strategy: Strategy = {
          id,
          version: 1,
          condition: {
            pattern: candidate.pattern,
            ...(candidate.taskClass !== undefined ? { taskClass: candidate.taskClass } : {}),
            ...(candidate.tool !== undefined ? { tool: candidate.tool } : {}),
          },
          action,
          sourcePattern: candidate.pattern,
          sampleCount: candidate.sampleCount,
          reliability: {
            score: gate.score,
            sampleCount: candidate.sampleCount,
            patternRate: candidate.patternRate,
            conflictRate: candidate.conflictRate,
            evidenceCompleteness: candidate.evidenceCompleteness,
            policyVersion: policy.version,
          },
          createdAt: now,
          lastValidatedAt: now,
          status: "enabled",
        };
        if (!isValidStrategyShape(strategy)) {
          decisions.push({
            strategyId: id,
            triggerPattern: candidate.pattern,
            reliability: gate.score,
            mode: store.mode,
            action,
            applied: false,
            reason: "invalid strategy shape (unsafe action vocabulary) — rejected",
            evidence: { sampleCount: candidate.sampleCount, patternRate: candidate.patternRate },
            at: now,
          });
          continue;
        }
        next = upsertStrategy(next, strategy);
        decisions.push({
          strategyId: id,
          triggerPattern: candidate.pattern,
          reliability: gate.score,
          mode: store.mode,
          action,
          applied: store.mode === "apply",
          reason:
            store.mode === "apply"
              ? "reliability gate passed — strategy approved and applicable"
              : `reliability gate passed — strategy approved (mode ${store.mode}: not applied)`,
          evidence: { sampleCount: candidate.sampleCount, patternRate: candidate.patternRate },
          at: now,
        });
      }
      saveStrategyStore(dir, next);
      return decisions;
    },

    applicableStrategies(now: number = Date.now()): Strategy[] {
      const store = loadStrategyStore(dir);
      if (store.mode !== "apply") return [];
      return store.strategies.filter((s) => {
        if (s.status !== "enabled") return false;
        const age = now - Date.parse(s.lastValidatedAt);
        return Number.isFinite(age) && age <= policy.maxAgeMs;
      });
    },

    decide(pattern: string, mode?: AdaptiveMode): StrategyDecision | null {
      const store = loadStrategyStore(dir);
      const effectiveMode = mode ?? store.mode;
      const strategy = store.strategies.find((s) => s.condition.pattern === pattern);
      if (strategy === undefined) return null;
      const applicable =
        effectiveMode === "apply" &&
        strategy.status === "enabled" &&
        Date.now() - Date.parse(strategy.lastValidatedAt) <= policy.maxAgeMs;
      return {
        strategyId: strategy.id,
        triggerPattern: pattern,
        reliability: strategy.reliability.score,
        mode: effectiveMode,
        action: strategy.action,
        applied: applicable,
        reason: applicable
          ? "enabled strategy matched — verification added to the run"
          : `not applied (mode ${effectiveMode}, status ${strategy.status})`,
        evidence: {
          sampleCount: strategy.sampleCount,
          patternRate: strategy.reliability.patternRate,
        },
        at: new Date().toISOString(),
      };
    },

    store(): StrategyStoreShape {
      return loadStrategyStore(dir);
    },

    refresh(now: number = Date.now()): StrategyDecision[] {
      const store = loadStrategyStore(dir);
      const decisions: StrategyDecision[] = [];
      let changed = false;
      const strategies = store.strategies.map((s) => {
        const age = now - Date.parse(s.lastValidatedAt);
        if (s.status === "enabled" && Number.isFinite(age) && age > policy.maxAgeMs) {
          changed = true;
          decisions.push({
            strategyId: s.id,
            triggerPattern: s.condition.pattern,
            reliability: s.reliability.score,
            mode: store.mode,
            action: s.action,
            applied: false,
            reason: `strategy stale (age ${Math.round(age / 86_400_000)}d > policy) — no longer applicable`,
            evidence: { sampleCount: s.sampleCount, patternRate: s.reliability.patternRate },
            at: new Date().toISOString(),
          });
          return { ...s, status: "stale" as const };
        }
        return s;
      });
      if (changed) saveStrategyStore(dir, { ...store, strategies });
      return decisions;
    },
  };
}

/** Version of the strategy store schema (re-exported for consumers). */
export const ADAPTIVE_STORE_VERSION = STRATEGY_STORE_VERSION;
