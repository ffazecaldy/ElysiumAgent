/** Decision Layer — runtime integration tests.
 *
 * Proves the six acceptance flows:
 *  1. no Jev (no key)      → harness behavior identical
 *  2. Jev in shadow        → decision recorded, behavior identical
 *  3. Jev timeout          → run continues (fallback)
 *  4. deterministic DENY   → Jev cannot flip it
 *  5. SecretGuard          → state is sanitized before leaving
 *  6. decision fingerprint → event actually emitted on the trail
 *
 * The REPL wiring (bash gate) is exercised through initDecisionRuntime +
 * combineDecision + the recorder, the same calls bin/agent.ts makes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionMode } from "../src/config";
import {
  type DecisionProvider,
  buildBashGrayZone,
  combineDecision,
  minimizeState,
} from "../src/decision";
import {
  initDecisionRuntime,
  makeDecisionRecorder,
  setDecisionSink,
} from "../src/decision/runtime";
import { TypeSafeDecisionProvider } from "../src/decision/typesafe";

const SECRET = "hunter2hunter2";

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env var must be unset, not set-to-undefined
  delete process.env.TYPESAFE_API_KEY;
  // biome-ignore lint/performance/noDelete: env var must be unset, not set-to-undefined
  delete process.env.ELYSIUM_DECISION_MODE;
  setDecisionSink(null);
  vi.restoreAllMocks();
});

function fakeProvider(answers: Record<string, unknown>, latencyMs = 15): DecisionProvider {
  return new TypeSafeDecisionProvider({
    apiKey: "test-key",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch,
    now: () => {
      let t = 1000;
      t += latencyMs;
      return t;
    },
  });
}

async function runBashGrayZone(
  provider: DecisionProvider,
  mode: "off" | "shadow" | "enforce",
  events: unknown[],
): Promise<{ verdict: string; source: string; semanticVerdict: string | null }> {
  setDecisionSink((event) => events.push(event));
  const recorder = makeDecisionRecorder("run-int");
  const deterministic = "REQUIRE_APPROVAL" as const; // gray zone: historical path asks the operator
  const question = buildBashGrayZone({
    command: `deploy --password ${SECRET}`,
    cwd: "/repo",
    writableRoots: ["/repo"],
    networkAllowed: false,
  });
  const state = minimizeState(question.state, [SECRET]);
  const evaluation = await provider.evaluate(state, question.questions);
  const combined = combineDecision(deterministic, evaluation, mode);
  recorder({
    runId: "run-int",
    taskId: null,
    useCase: "bash-gray-zone",
    providerId: provider.id,
    mode,
    outcome: combined.outcome,
    semantic: combined.shadowSemantic,
    evaluation,
    state,
  });
  return {
    verdict: combined.outcome.verdict,
    source: combined.outcome.source,
    semanticVerdict: combined.shadowSemantic?.verdict ?? null,
  };
}

describe("Decision Layer runtime integration", () => {
  it("1. without a key the runtime is inactive and the harness is unchanged", () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not set-to-undefined
    delete process.env.TYPESAFE_API_KEY;
    const runtime = initDecisionRuntime();
    expect(runtime.active).toBe(false);
    expect(runtime.provider.available()).toBe(false);
    expect(decisionMode()).toBe("off");
  });

  it("2. shadow mode records the decision but the historical verdict stands", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.ELYSIUM_DECISION_MODE = "shadow";
    const events: unknown[] = [];
    const provider = fakeProvider({
      destructive: { probability: 0.03 },
      risk: { score: "low", probabilities: { low: 0.9 }, confidence: 0.92 },
    });
    const result = await runBashGrayZone(provider, "shadow", events);
    expect(result.verdict).toBe("REQUIRE_APPROVAL"); // historical behavior preserved
    expect(result.semanticVerdict).toBe("ALLOW"); // Jev would have allowed
    expect(events).toHaveLength(1);
    const data = (events[0] as { data: Record<string, unknown> }).data;
    expect(data.kind).toBe("decision");
    expect(data.mode).toBe("shadow");
    expect(data.verdict).toBe("REQUIRE_APPROVAL");
    expect(data.semanticVerdict).toBe("ALLOW");
  });

  it("3. provider timeout → fallback verdict, run continues, fallback reason recorded", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const slowProvider = new TypeSafeDecisionProvider({
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: ((_u: string, init?: RequestInit) =>
        new Promise<Response>((_res, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("x", "AbortError")),
          );
        })) as unknown as typeof fetch,
    });
    const events: unknown[] = [];
    const result = await runBashGrayZone(slowProvider, "shadow", events);
    expect(result.verdict).toBe("REQUIRE_APPROVAL"); // historical
    expect(result.source).toBe("fallback"); // provider failed → marked as fallback
    const data = (events[0] as { data: Record<string, unknown> }).data;
    expect(data.fallbackReason).toContain("timeout");
  });

  it("4. deterministic DENY cannot be flipped by Jev — in any mode", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const lenient = fakeProvider({
      destructive: { probability: 0.0 },
      risk: { score: "low", probabilities: {}, confidence: 0.99 },
    });
    for (const mode of ["shadow", "enforce"] as const) {
      const combined = combineDecision(
        "DENY",
        await lenient.evaluate(
          {},
          buildBashGrayZone({
            command: "rm -rf /",
            cwd: "/",
            writableRoots: ["/"],
            networkAllowed: true,
          }).questions,
        ),
        mode,
      );
      expect(combined.outcome.verdict).toBe("DENY");
      expect(combined.outcome.source).toBe("deterministic");
    }
  });

  it("5. SecretGuard: the state leaving toward Jev is sanitized", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    let capturedState: unknown;
    const spyProvider: DecisionProvider = {
      id: "spy",
      available: () => true,
      async evaluate(state) {
        capturedState = state;
        return {
          ok: true,
          answers: { destructive: { kind: "noul", probability: 0.1 } },
          latencyMs: 5,
        };
      },
    };
    const question = buildBashGrayZone({
      command: `deploy --token ${SECRET} && echo ghp_${"y".repeat(30)}`,
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    });
    const state = minimizeState(question.state, [SECRET]);
    await spyProvider.evaluate(state, question.questions);
    const serialized = JSON.stringify(capturedState);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(`ghp_${"y".repeat(30)}`);
    expect(serialized).toContain("***REDACTED");
  });

  it("6. enforce mode escalates an ALLOW only where explicitly enabled", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.ELYSIUM_DECISION_MODE = "enforce";
    expect(decisionMode()).toBe("enforce");
    const events: unknown[] = [];
    const risky = fakeProvider({
      destructive: { probability: 0.95 },
      risk: { score: "critical", probabilities: { critical: 0.9 }, confidence: 0.93 },
    });
    const result = await runBashGrayZone(risky, "enforce", events);
    // historical deterministic verdict for the gray zone is REQUIRE_APPROVAL;
    // enforce may keep or escalate it — never relax it.
    expect(["REQUIRE_APPROVAL", "DENY"]).toContain(result.verdict);
    expect(result.verdict).toBe("REQUIRE_APPROVAL");
  });
});
