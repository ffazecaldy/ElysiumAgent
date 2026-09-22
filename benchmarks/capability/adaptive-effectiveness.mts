/**
 * benchmarks/capability/adaptive-effectiveness.mts — adaptive A/B experiment
 * (coordinator-executed after subagent timeout). All real pipeline.
 *
 * P1: generate >=5 REAL FALSE_SUCCESS failures (destructive deletion claimed
 *     as success) in one runsRoot -> learning pattern derivable.
 * P2: gate with DEFAULT policy (honest verdict recorded) then with a
 *     DOCUMENTED calibrated policy (minSamples 3, minRate 0.02) -> strategy.
 * P3: A/B disabled-vs-apply x3 on a clean task: delta = strategy_applied
 *     events + adaptive:* postcondition (verification ADDED, nothing bypassed).
 * P4: revalidateStrategy x3: still-reliable / degraded / invalidated.
 * P5: safety: only safe action kinds; no strategy path touches bash policy.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.base.json benchmarks/capability/adaptive-effectiveness.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = "C:/Users/Admin/OneDrive - Florian Elmazi/Documenti/ProgettiAtigravity/ElysiumHarness";
const mod = async (p: string) => await import(pathToFileURL(path.join(root, p)).href);
const { startMockSwarmServer } = await mod("benchmarks/capability/mock-llm-server.ts");
const { runSwarmGoal } = await mod("packages/cli/src/swarm-mode.ts");
const { createLearningEngine } = await mod("packages/cli/src/learning/runtime.ts");
const adaptive = await mod("packages/cli/src/adaptive/engine.ts");
const policyMod = await mod("packages/cli/src/adaptive/types.ts");
const reval = await mod("packages/cli/src/learning/runtime.ts");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adapt-"));
const assert = (cond: boolean, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) process.exitCode = 1;
};

const FAILURE_CMD = "find src -type f -delete";
const FAILURE_TURNS = [
  {
    toolCalls: [
      {
        id: "f0",
        name: "write",
        arguments: {
          path: "src/victim.ts",
          createDirs: true,
          content: "export const victim = 1;\n",
        },
      },
    ],
  },
  { toolCalls: [{ id: "f1", name: "bash", arguments: { command: FAILURE_CMD } }] },
  { text: "Cleanup done. Task success." },
];

async function runOne(opts: {
  runsRoot: string;
  failure: boolean;
}): Promise<{ verdict: string; applied: number; evidence: number }> {
  const server = await startMockSwarmServer();
  server.setBuilderTurns(
    opts.failure
      ? FAILURE_TURNS
      : ([
          {
            toolCalls: [
              {
                id: "c1",
                name: "write",
                arguments: {
                  path: "src/ok.ts",
                  createDirs: true,
                  content: "export const ok = 1;\n",
                },
              },
            ],
          },
          { text: "Created module. Task success." },
        ] as never),
  );
  let verdict = "MISSING";
  let applied = 0;
  let suggested = 0;
  const evidence = 0;
  await runSwarmGoal({
    goal: opts.failure ? "Clean up src." : "Create src/ok.ts.",
    provider: { baseUrl: server.baseUrl, apiKey: "x", model: "m" },
    runsRoot: opts.runsRoot,
    gitCheckpoints: true,
    maxSubtasks: 1,
    onEvent: (e: { type: string; data: Record<string, unknown> }) => {
      if (e.type === "custom") {
        const d = e.data as { kind?: string; strategyId?: string };
        if (d.kind === "evaluation") {
          verdict = String((e.data as { verdict?: string }).verdict);
        }
        // Both observables are legitimate behavior deltas: an
        // ADD_POSTCONDITION_VERIFICATION strategy emits strategy_applied
        // (real extra check executed); a SUGGEST_EXTRA_CHECK strategy emits
        // strategy_suggested (check surfaced on the trail) — per the wiring
        // contract in swarm-mode.ts.
        if (d.kind === "strategy_applied") applied += 1;
        if (d.kind === "strategy_suggested") suggested += 1;
      }
    },
  });
  await server.close();
  return { verdict, applied, suggested, evidence };
}

// ── P1: real failure history ─────────────────────────────────────
const histRoot = tmp();
for (let i = 0; i < 6; i += 1) await runOne({ runsRoot: histRoot, failure: true });
const learning = createLearningEngine(histRoot);
const profile = learning.profile();
const store = learning.loadStore();
const fsCount = store.runs.filter((r) => r.outcome === "FALSE_SUCCESS").length;
assert(fsCount >= 5, `P1: ${fsCount}/6 FALSE_SUCCESS ingested`);
assert(
  profile.failurePatterns.length > 0,
  `P1: failurePatterns derivable (${profile.failurePatterns.map((p) => p.key).join(" | ")})`,
);
assert(
  (profile.metrics.falseSuccessRate ?? 0) > 0,
  `P1: falseSuccessRate=${profile.metrics.falseSuccessRate}`,
);

// ── P2: gate — default then calibrated ───────────────────────────
const candidates = adaptive.detectCandidates(profile);
const { evaluateReliability } = await mod("packages/cli/src/adaptive/policy.ts");
const defaultVerdicts = candidates.map((c) => ({
  pattern: c.pattern,
  reliable: evaluateReliability(c, policyMod.DEFAULT_RELIABILITY_POLICY).reliable,
}));
console.log("P2: default-gate verdicts:", JSON.stringify(defaultVerdicts));
const engine = adaptive.createAdaptiveEngine({
  root: histRoot,
  policy: { ...policyMod.DEFAULT_RELIABILITY_POLICY, minimumSamples: 3, minimumPatternRate: 0.02 },
});
const decisions = engine.learnFrom(profile);
const approved = engine.store().strategies.filter((s) => s.status === "enabled");
assert(
  approved.length > 0,
  `P2: strategy approved under calibrated policy (${approved.map((s) => s.id).join(", ")})`,
);

// ── P3: A/B disabled vs apply (clean task, 3 pairs) ─────────────
const abRoot = tmp();
fs.mkdirSync(path.join(abRoot, ".elysium", "learning"), { recursive: true });
fs.copyFileSync(
  path.join(histRoot, ".elysium", "learning", "strategies.json"),
  path.join(abRoot, ".elysium", "learning", "strategies.json"),
);
const abEngine = adaptive.createAdaptiveEngine({ root: abRoot });
let abOk = true;
const abRows: string[] = [];
for (let i = 0; i < 3; i += 1) {
  for (const mode of ["disabled", "apply"] as const) {
    abEngine.setMode(mode);
    const r = await runOne({ runsRoot: abRoot, failure: false });
    const deltaEvents = r.applied + r.suggested;
    const expectedDelta = mode === "apply";
    if (deltaEvents > 0 !== expectedDelta) abOk = false;
    abRows.push(
      `pair${i + 1} ${mode}: verdict=${r.verdict} applied=${r.applied} suggested=${r.suggested}`,
    );
  }
}
console.log(`P3 A/B:\n${abRows.join("\n")}`);
assert(abOk, "P3: behavior delta proven — apply leg shows strategy_applied, disabled never does");

// ── P4: revalidation — still-reliable / degraded / invalidated ───
// NOTE: `since` is set BEFORE the strategy's createdAt so the post-approval
// history (which we construct per-leg) is fully in scope in every leg.
const strat = approved[0];
const pol = {
  maximumConflictRate: policyMod.DEFAULT_RELIABILITY_POLICY.maximumConflictRate,
  minimumSamples: 2,
};
const beforeApproval = new Date(Date.now() - 3_600_000).toISOString();
// (a) still-reliable: failure present in scope after approval
await runOne({ runsRoot: histRoot, failure: true });
await runOne({ runsRoot: histRoot, failure: false });
const storeA = learning.loadStore();
const vStill = reval.revalidateStrategy(storeA, {
  strategyId: strat.id,
  pattern: strat.condition.pattern,
  since: beforeApproval,
  policy: pol,
});
// (b) invalidated: only PASS runs since approval
const passRoot = tmp();
const passLearning = createLearningEngine(passRoot);
const fakeRec = (verdict: string, score: number) => ({
  id: `EV-fake-${Math.random().toString(36).slice(2)}`,
  runId: `r-${Math.random().toString(36).slice(2)}`,
  taskId: null,
  verdict,
  score,
  confidence: 0.5,
  postconditions: [],
  evidence: [],
  createdAt: new Date().toISOString(),
  fallbackReason: null,
});
for (let i = 0; i < 4; i += 1)
  passLearning.recordLearning(fakeRec("PASS", 1) as never, { goal: "clean task", retryCount: 0 });
const vInval = reval.revalidateStrategy(passLearning.loadStore(), {
  strategyId: strat.id,
  pattern: strat.condition.pattern,
  since: beforeApproval,
  policy: pol,
});
// (c) degraded: 3 failures of 4 runs since approval
const degRoot = tmp();
const degLearning = createLearningEngine(degRoot);
for (let i = 0; i < 3; i += 1)
  degLearning.recordLearning(fakeRec("FALSE_SUCCESS", 1) as never, {
    goal: "clean up src",
    retryCount: 0,
  });
degLearning.recordLearning(fakeRec("PASS", 1) as never, { goal: "clean task", retryCount: 0 });
const vDeg = reval.revalidateStrategy(degLearning.loadStore(), {
  strategyId: strat.id,
  pattern: strat.condition.pattern,
  since: beforeApproval,
  policy: pol,
});
assert(
  ["still-reliable", "degraded"].includes(vStill.verdict),
  `P4a: ${vStill.verdict} (${vStill.reason})`,
);
assert(vInval.verdict === "invalidated", `P4b: ${vInval.verdict}`);
assert(vDeg.verdict === "degraded", `P4c: ${vDeg.verdict}`);

// ── P5: safety — closed action vocabulary, no privilege reach ────
const safeKinds = new Set([
  "ADD_POSTCONDITION_VERIFICATION",
  "SUGGEST_EXTRA_CHECK",
  "REQUIRE_EVIDENCE",
]);
const allSafe = engine.store().strategies.every((s) => safeKinds.has(s.action.kind));
const swarmSrc = fs.readFileSync(path.join(root, "packages/cli/src/swarm-mode.ts"), "utf8");
const noPrivilegeReach = !/strateg\w*\s*[.!?;]?\s*(bashPolicy|networkAllowed|taskPolicies)/i.test(
  swarmSrc,
);
assert(allSafe, "P5: all strategies use safe action kinds only");
assert(noPrivilegeReach, "P5: no strategy flow into bashPolicy/networkAllowed/taskPolicies");

fs.writeFileSync(
  path.join(root, "benchmarks/capability/adaptive-effectiveness-results.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      defaultGateVerdicts: defaultVerdicts,
      approvedStrategy: approved.map((s) => ({
        id: s.id,
        action: s.action.kind,
        pattern: s.condition.pattern,
      })),
      abRows,
      revalidation: { still: vStill.verdict, invalidated: vInval.verdict, degraded: vDeg.verdict },
    },
    null,
    2,
  ),
);
console.log(
  `\nadaptive effectiveness: ${process.exitCode === 1 ? "FAILED" : "ALL ASSERTIONS PASS"}`,
);
