/** Evaluation Layer — unit tests: verdict matrix, bounds, cycle-safety, runtime seam. */
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceItem as EvaluationItem, Postcondition } from "../src/evaluation";
import {
  MAX_EVIDENCE,
  boundEvidence,
  boundFacts,
  buildCriticPostcondition,
  buildExitCodePostcondition,
  buildRollbackPostcondition,
  capString,
  createEvaluationRuntime,
  evaluateEvidence,
  resetEvaluationIds,
} from "../src/evaluation";

afterEach(() => {
  resetEvaluationIds();
});

const item = (
  overrides: Partial<Parameters<typeof boundEvidence>[0]> & { id?: string },
): EvaluationItem => ({
  id: overrides.id ?? `e${Math.random().toString(36).slice(2)}`,
  kind: overrides.kind ?? "tool_outcome",
  at: "2026-01-01T00:00:00.000Z",
  source: overrides.source ?? "tool",
  facts: overrides.facts ?? {},
  ...(overrides.claim !== undefined ? { claim: overrides.claim } : {}),
});

const post = (name: string, ok: boolean | null): Postcondition => ({
  name,
  expected: {},
  observed: {},
  ok,
});

describe("evaluateEvidence — verdict matrix", () => {
  it("PASS when every postcondition is verified true", () => {
    const r = evaluateEvidence([item({})], [post("a", true), post("b", true)]);
    expect(r.verdict).toBe("PASS");
    expect(r.score).toBe(1);
  });

  it("FAIL when any postcondition is false (no success claim)", () => {
    const r = evaluateEvidence([item({})], [post("a", true), post("b", false)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.score).toBe(0.5);
  });

  it("INSUFFICIENT when no postcondition is verifiable", () => {
    const r = evaluateEvidence([item({})], [post("a", null), post("b", null)]);
    expect(r.verdict).toBe("INSUFFICIENT");
  });

  it("INSUFFICIENT with zero postconditions (score defaults 0.5)", () => {
    const r = evaluateEvidence([item({})], []);
    expect(r.verdict).toBe("INSUFFICIENT");
    expect(r.score).toBe(0.5);
  });

  it("FALSE_SUCCESS when a success claim contradicts a failed postcondition", () => {
    const ev = [item({ kind: "claim", source: "report", claim: "rollback success" })];
    const r = evaluateEvidence(ev, [post("rollback", false)]);
    expect(r.verdict).toBe("FALSE_SUCCESS");
  });

  it("FALSE_SUCCESS when a fail-open critic passed=true contradicts facts", () => {
    const ev = [
      item({ kind: "critic_verdict", source: "critic", facts: { passed: true, failOpen: true } }),
    ];
    const r = evaluateEvidence(ev, [post("critic", false)]);
    expect(r.verdict).toBe("FALSE_SUCCESS");
  });

  it("FALSE_SUCCESS for rollback claim vs dirty git_state even with all postconditions true", () => {
    const ev = [
      item({ kind: "claim", source: "repair", claim: "rollback success" }),
      item({ kind: "git_state", source: "git", facts: { clean: false } }),
      item({}),
    ];
    const r = evaluateEvidence(ev, [post("a", true)]);
    expect(r.verdict).toBe("FALSE_SUCCESS");
  });

  it("PASS with a success claim that nothing contradicts", () => {
    const ev = [item({ kind: "claim", source: "report", claim: "build succeeded" }), item({})];
    const r = evaluateEvidence(ev, [post("a", true)]);
    expect(r.verdict).toBe("PASS");
  });

  it("confidence null with fewer than 2 evidence items", () => {
    const r = evaluateEvidence([item({})], [post("a", true)]);
    expect(r.confidence).toBeNull();
  });

  it("confidence is the minimum fact confidence across evidence", () => {
    const ev = [
      item({ facts: { confidence: 0.9 } }),
      item({ facts: { confidence: 0.3 } }),
      item({ facts: { noConfidence: 1 } }),
    ];
    expect(evaluateEvidence(ev, [post("a", true)]).confidence).toBe(0.3);
  });

  it("confidence defaults 0.5 with >=2 evidence but no fact confidence", () => {
    expect(evaluateEvidence([item({}), item({})], [post("a", true)]).confidence).toBe(0.5);
  });
});

describe("domain postcondition builders", () => {
  it("buildRollbackPostcondition: clean after-state passes", () => {
    const p = buildRollbackPostcondition(
      { head: "abc1234", untracked: ["x"], modified: ["y"] },
      { head: "abc1234", untracked: [], modified: [] },
    );
    expect(p.ok).toBe(true);
  });

  it("buildRollbackPostcondition: dirty after-state fails", () => {
    const p = buildRollbackPostcondition(
      { head: "abc1234", untracked: [], modified: [] },
      { head: "abc1234", untracked: ["leftover.txt"], modified: [] },
    );
    expect(p.ok).toBe(false);
  });

  it("buildRollbackPostcondition: head changed fails", () => {
    const p = buildRollbackPostcondition({ head: "abc1234" }, { head: "def5678" });
    expect(p.ok).toBe(false);
  });

  it("buildRollbackPostcondition: missing head is unverifiable (null)", () => {
    const p = buildRollbackPostcondition({ head: null }, { head: "abc1234" });
    expect(p.ok).toBeNull();
  });

  it("buildExitCodePostcondition: 0 passes, non-zero fails, null unverifiable", () => {
    expect(buildExitCodePostcondition("npm test", 0, ["ok"]).ok).toBe(true);
    expect(buildExitCodePostcondition("npm test", 1, ["ok"]).ok).toBe(false);
    expect(buildExitCodePostcondition("npm test", null, []).ok).toBeNull();
  });

  it("buildCriticPostcondition: B17 fail-open passed=true is ok=false", () => {
    expect(buildCriticPostcondition({ passed: true, failOpen: true }).ok).toBe(false);
    expect(buildCriticPostcondition({ passed: true, failOpen: false }).ok).toBe(true);
    expect(buildCriticPostcondition({ passed: false, failOpen: true }).ok).toBe(false);
    expect(buildCriticPostcondition({ passed: null, failOpen: true }).ok).toBeNull();
  });
});

describe("bounds and cycle-safety", () => {
  it("projectFacts drops cyclic references without throwing", () => {
    const cyc: Record<string, unknown> & { self?: unknown } = { a: 1 };
    cyc.self = cyc;
    expect(() => boundFacts(cyc)).not.toThrow();
    const out = boundFacts(cyc);
    expect(out.a).toBe(1);
    expect("self" in out).toBe(false);
  });

  it("capString marks overflow deterministically", () => {
    const long = "x".repeat(3000);
    const capped = capString(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped.endsWith("…[capped]")).toBe(true);
  });

  it("boundEvidence caps oversized claims and facts strings", () => {
    const bounded = boundEvidence(
      item({ kind: "claim", claim: "y".repeat(3000), facts: { s: "z".repeat(3000) } }),
    );
    // 2000 chars + 9-char cap marker.
    expect((bounded.claim ?? "").length).toBeLessThanOrEqual(2009);
    expect((bounded.claim ?? "").endsWith("…[capped]")).toBe(true);
    expect(String(bounded.facts.s).endsWith("…[capped]")).toBe(true);
  });

  it("runtime buffer keeps at most MAX_EVIDENCE items", () => {
    const rt = createEvaluationRuntime({ runId: "r" });
    for (let i = 0; i < MAX_EVIDENCE + 1; i++) {
      rt.observe({ kind: "tool_outcome", source: "tool", facts: { i } });
    }
    const rec = rt.evaluate();
    expect(rec?.evidence.length).toBe(MAX_EVIDENCE);
  });

  it("deeply nested facts flatten at the depth budget instead of exploding", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { nest: deep };
    expect(() => boundFacts(deep)).not.toThrow();
  });
});

describe("runtime seam", () => {
  it("evaluate returns null on an empty buffer", () => {
    const rt = createEvaluationRuntime({ runId: "r" });
    expect(rt.evaluate()).toBeNull();
  });

  it("evaluate does not drain the buffer", () => {
    const rt = createEvaluationRuntime({ runId: "r" });
    rt.observe({ kind: "tool_outcome", source: "tool", facts: {} });
    const r1 = rt.evaluate();
    const r2 = rt.evaluate();
    expect(r1?.evidence.length).toBe(1);
    expect(r2?.evidence.length).toBe(1);
  });

  it("a throwing sink never propagates", () => {
    const rt = createEvaluationRuntime({
      runId: "r",
      sink: () => {
        throw new Error("sink exploded");
      },
    });
    rt.observe({ kind: "tool_outcome", source: "tool", facts: {} });
    expect(() => rt.evaluate()).not.toThrow();
  });

  it("ids are monotonic per run and reset() keeps the counter", () => {
    const rt = createEvaluationRuntime({ runId: "run7" });
    const e1 = rt.observe({ kind: "tool_outcome", source: "tool", facts: {} });
    const e2 = rt.observe({ kind: "tool_outcome", source: "tool", facts: {} });
    expect(e1.id).toBe("EV-run7-1");
    expect(e2.id).toBe("EV-run7-2");
    rt.reset();
    const e3 = rt.observe({ kind: "tool_outcome", source: "tool", facts: {} });
    expect(e3.id).toBe("EV-run7-3");
  });

  it("postcondition_check evidence feeds the verdict", () => {
    const rt = createEvaluationRuntime({ runId: "r" });
    rt.observe({
      kind: "claim",
      source: "report",
      facts: {},
      claim: "everything ok",
    });
    rt.observe({
      kind: "postcondition_check",
      source: "tool",
      facts: { name: "p1", ok: false },
    });
    const rec = rt.evaluate("task-9");
    expect(rec?.verdict).toBe("FALSE_SUCCESS");
    expect(rec?.taskId).toBe("task-9");
  });
});
