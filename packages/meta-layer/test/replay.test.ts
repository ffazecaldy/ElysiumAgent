import { describe, expect, it } from "vitest";
import { fingerprintTrajectory, serializeFingerprint } from "../src/fingerprint";
import type { TrajectoryFingerprint, TrajectoryRecord } from "../src/fingerprint";
import {
  TrajectoryRecorder,
  replayAgainst,
  replayFingerprint,
  stepsToTrajectory,
} from "../src/replay";
import type { ReplayStep } from "../src/replay";

/** Set di 6 step misti usato in più test (il fingerprint atteso è calcolato a mano). */
function mixedSteps(): ReplayStep[] {
  return [
    {
      seq: 1,
      tool: "read",
      input: { path: "src/a.ts" },
      result: { isError: false, filesTouched: ["src/a.ts"] },
      at: "2026-09-17T10:00:00.000Z",
    },
    {
      seq: 2,
      tool: "edit",
      input: { path: "src/a.ts" },
      result: { isError: false, outputTokens: 40, filesTouched: ["src/a.ts", "src/b.ts"] },
      at: "2026-09-17T10:00:01.000Z",
    },
    {
      seq: 3,
      tool: "bash",
      input: { command: "pnpm test" },
      result: { isError: true, outputTokens: 10 },
      at: "2026-09-17T10:00:02.000Z",
    },
    {
      seq: 4,
      tool: "test",
      input: { suite: "unit" },
      result: { isError: false, outputTokens: 120, filesTouched: [] },
      at: "2026-09-17T10:00:03.000Z",
    },
    {
      seq: 5,
      tool: "other",
      input: { op: "search" },
      result: { isError: false, outputTokens: 5 },
      at: "2026-09-17T10:00:04.000Z",
    },
    {
      seq: 6,
      tool: "read",
      input: { path: "src/c.ts" },
      result: { isError: false, outputTokens: 30, filesTouched: ["src/c.ts"] },
      at: "2026-09-17T10:00:05.000Z",
    },
  ];
}

/** Fingerprint atteso, calcolato a mano sulla traiettoria dei 6 step misti. */
const EXPECTED_MIXED: TrajectoryFingerprint = {
  read: 2, // step 1 + step 6
  edit: 1, // step 2
  bash: 1, // step 3
  test: 1, // step 4
  other: 1, // step 5
  retries: 0,
  errors: 1, // step 3 isError
  tokensIn: 0,
  tokensOut: 40 + 10 + 120 + 5 + 30, // = 205
  filesTouched: 3, // union: src/a.ts, src/b.ts, src/c.ts
};

describe("TrajectoryRecorder", () => {
  it("assegna seq progressivo e timestamp ISO", () => {
    const recorder = new TrajectoryRecorder();
    const s1 = recorder.record("read", { path: "a.ts" }, { isError: false });
    const s2 = recorder.record("edit", { path: "a.ts" }, { isError: false, outputTokens: 12 });
    const s3 = recorder.record("bash", { command: "ls" }, { isError: true });

    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);
    expect(s3.seq).toBe(3);
    expect(s1.tool).toBe("read");
    expect(s2.result.outputTokens).toBe(12);
    expect(s3.result.isError).toBe(true);

    for (const step of [s1, s2, s3]) {
      expect(() => new Date(step.at)).not.toThrow();
      expect(new Date(step.at).toISOString()).toBe(step.at);
      expect(step.input).toEqual(expect.any(Object));
    }
  });

  it("steps() restituisce una copia indipendente", () => {
    const recorder = new TrajectoryRecorder();
    recorder.record("read", {}, { isError: false });

    const copy = recorder.steps();
    expect(copy).toHaveLength(1);
    copy.push({
      seq: 99,
      tool: "other",
      input: {},
      result: { isError: false },
      at: "2026-09-17T10:00:00.000Z",
    });
    for (const step of copy) {
      step.seq = 42;
    }

    expect(recorder.steps()).toHaveLength(1);
    expect(recorder.steps()[0]?.seq).toBe(1);
  });
});

describe("stepsToTrajectory", () => {
  it("mappa ogni step su tool_call + token_usage con filesTouched riflessi", () => {
    const records = stepsToTrajectory(mixedSteps());

    // 6 tool_call + 1 error (step 3) + 5 token_usage (gli step con outputTokens) = 12 record.
    expect(records).toHaveLength(12);

    const calls = records.filter((r) => r.kind === "tool_call");
    expect(calls.map((r) => r.tool)).toEqual(["read", "edit", "bash", "test", "other", "read"]);
    expect(records.filter((r) => r.kind === "error")).toHaveLength(1);
    expect(calls.some((r) => r.isError === true)).toBe(false);

    // filesTouched riflessi nel tool_call corrispondente.
    expect(calls[0]?.filesTouched).toEqual(["src/a.ts"]);
    expect(calls[1]?.filesTouched).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls[3]?.filesTouched).toEqual([]);

    const tokenRecords = records.filter((r) => r.kind === "token_usage");
    expect(tokenRecords.map((r) => r.outputTokens)).toEqual([40, 10, 120, 5, 30]);
  });

  it("emette solo il tool_call quando il result non ha token né file", () => {
    const step: ReplayStep = {
      seq: 1,
      tool: "read",
      input: { path: "x.ts" },
      result: { isError: false },
      at: "2026-09-17T10:00:00.000Z",
    };
    const records: TrajectoryRecord[] = stepsToTrajectory([step]);
    expect(records).toEqual([{ kind: "tool_call", tool: "read" }]);
  });
});

describe("replayFingerprint (roundtrip)", () => {
  it("riproduce il fingerprint atteso calcolato a mano sulla traiettoria", () => {
    const steps = mixedSteps();

    // Via passante per i TrajectoryRecord (stepsToTrajectory + fingerprintTrajectory reale).
    const viaTrajectory = fingerprintTrajectory(stepsToTrajectory(steps));

    // Atteso calcolato a mano.
    expect(viaTrajectory).toEqual(EXPECTED_MIXED);
    expect(replayFingerprint(steps)).toEqual(EXPECTED_MIXED);
    expect(serializeFingerprint(replayFingerprint(steps))).toBe(
      serializeFingerprint(EXPECTED_MIXED),
    );
  });

  it("restituisce tutti zeri per nessuno step", () => {
    expect(replayFingerprint([])).toEqual({
      read: 0,
      edit: 0,
      bash: 0,
      test: 0,
      other: 0,
      retries: 0,
      errors: 0,
      tokensIn: 0,
      tokensOut: 0,
      filesTouched: 0,
    });
  });
});

describe("replayAgainst", () => {
  it("match=true sugli stessi step contro il fingerprint atteso", () => {
    const steps = mixedSteps();
    const result = replayAgainst(steps, EXPECTED_MIXED);
    expect(result.match).toBe(true);
    expect(result.deltas).toEqual([]);
  });

  it("match=false con delta sul campo cambiato quando uno step viene manomesso (isError)", () => {
    const steps = mixedSteps();
    const expected = replayFingerprint(steps);

    const tampered = steps.map((s, i) =>
      i === 2 ? { ...s, result: { ...s.result, isError: false } } : { ...s },
    );

    const result = replayAgainst(tampered, expected);
    expect(result.match).toBe(false);
    expect(result.deltas).toEqual([{ field: "errors", from: 1, to: 0, delta: -1 }]);
  });

  it("match=false con delta sui campi cambiati quando uno step viene manomesso (bash→edit)", () => {
    const steps = mixedSteps();
    const expected = replayFingerprint(steps);

    const tampered = steps.map((s, i) => (i === 2 ? { ...s, tool: "edit" as const } : { ...s }));

    const result = replayAgainst(tampered, expected);
    expect(result.match).toBe(false);

    const fields = result.deltas.map((d) => d.field).sort();
    expect(fields).toEqual(["bash", "edit"]);
    expect(result.deltas).toContainEqual({ field: "bash", from: 1, to: 0, delta: -1 });
    expect(result.deltas).toContainEqual({ field: "edit", from: 1, to: 2, delta: 1 });
  });

  it("segnala anche delta su tokensOut e filesTouched", () => {
    const steps = mixedSteps();
    const expected = replayFingerprint(steps);

    const tampered = steps.map((s, i) =>
      i === 4
        ? { ...s, result: { ...s.result, outputTokens: 50, filesTouched: ["src/a.ts"] } }
        : { ...s },
    );

    const result = replayAgainst(tampered, expected);
    expect(result.match).toBe(false);
    expect(result.deltas).toContainEqual({ field: "tokensOut", from: 205, to: 250, delta: 45 });
    expect(result.deltas).toEqual([{ field: "tokensOut", from: 205, to: 250, delta: 45 }]); // src/a.ts già nell'unione
  });
});

describe("determinismo", () => {
  it("due replay dello stesso set producono serializeFingerprint identico", () => {
    const a = serializeFingerprint(replayFingerprint(mixedSteps()));
    const b = serializeFingerprint(replayFingerprint(mixedSteps()));
    expect(a).toBe(b);
  });

  it("il fingerprint via recorder coincide con quello via step letterali", () => {
    const recorder = new TrajectoryRecorder();
    recorder.record("read", { path: "src/a.ts" }, { isError: false, filesTouched: ["src/a.ts"] });
    recorder.record(
      "edit",
      { path: "src/a.ts" },
      { isError: false, outputTokens: 40, filesTouched: ["src/a.ts", "src/b.ts"] },
    );
    recorder.record("bash", { command: "pnpm test" }, { isError: true, outputTokens: 10 });
    recorder.record(
      "test",
      { suite: "unit" },
      { isError: false, outputTokens: 120, filesTouched: [] },
    );
    recorder.record("other", { op: "search" }, { isError: false, outputTokens: 5 });
    recorder.record(
      "read",
      { path: "src/c.ts" },
      { isError: false, outputTokens: 30, filesTouched: ["src/c.ts"] },
    );

    expect(serializeFingerprint(replayFingerprint(recorder.steps()))).toBe(
      serializeFingerprint(EXPECTED_MIXED),
    );
    expect(replayAgainst(recorder.steps(), EXPECTED_MIXED).match).toBe(true);
  });
});
