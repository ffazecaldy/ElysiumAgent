/**
 * packages/cli/test/claim-extraction.test.ts — F-08 test matrix.
 *
 * ONLY the final assistant summary is a claim surface; intermediate
 * narration must never influence the claim (the F-08 FALSE_SUCCESS bug).
 * Matrix: future/promise, conditional, negation, explicit outcome, quotes,
 * empty and ambiguous inputs — plus the narration-vs-final regression.
 */
import { describe, expect, it } from "vitest";
import { extractFinalClaim, isFailureClaim, successClaimText } from "../src/evaluation/claim";

describe("extractFinalClaim (F-08 unit matrix)", () => {
  it("future/promise narration + final null -> NONE (narrative ignored)", () => {
    const r = extractFinalClaim({
      finalSummary: null,
      narrative: ["I'll implement it and verify it succeeds later"],
    });
    expect(r.claim).toBe("NONE");
    expect(r.source).toBe("none");
  });

  it("future/promise final summary -> UNVERIFIED (intent, not outcome)", () => {
    const r = extractFinalClaim({
      finalSummary: "I'll implement it and verify it succeeds later",
    });
    expect(r.claim).toBe("UNVERIFIED");
    expect(r.source).toBe("final-summary");
  });

  it("explicit past outcome -> SUCCESS", () => {
    const r = extractFinalClaim({ finalSummary: "I successfully fixed it" });
    expect(r.claim).toBe("SUCCESS");
    expect(r.source).toBe("final-summary");
  });

  it("'The verification failed' -> FAILURE", () => {
    const r = extractFinalClaim({ finalSummary: "The verification failed" });
    expect(r.claim).toBe("FAILURE");
  });

  it("'I could not complete the task' -> FAILURE", () => {
    const r = extractFinalClaim({ finalSummary: "I could not complete the task" });
    expect(r.claim).toBe("FAILURE");
  });

  it("'I have not verified this yet' -> UNVERIFIED (not FAILURE)", () => {
    const r = extractFinalClaim({ finalSummary: "I have not verified this yet" });
    expect(r.claim).toBe("UNVERIFIED");
  });

  it("'\"success\" citato tra virgolette' -> NONE (quoted citation is not a claim)", () => {
    const r = extractFinalClaim({ finalSummary: 'the spec says "success" here' });
    expect(r.claim).toBe("NONE");
  });

  it("'not successful' -> FAILURE", () => {
    const r = extractFinalClaim({ finalSummary: "not successful" });
    expect(r.claim).toBe("FAILURE");
  });

  it("empty/null final -> NONE (status fallback and none)", () => {
    expect(extractFinalClaim({ finalSummary: null }).claim).toBe("NONE");
    expect(extractFinalClaim({ finalSummary: "" }).claim).toBe("NONE");
    expect(extractFinalClaim({ finalSummary: "   " }).source).toBe("none");
    const status = extractFinalClaim({ finalSummary: null, status: "completed" });
    expect(status.claim).toBe("SUCCESS");
    expect(status.source).toBe("status");
  });

  it("ambiguous final ('done maybe') -> NONE", () => {
    const r = extractFinalClaim({ finalSummary: "done maybe" });
    expect(r.claim).toBe("NONE");
  });

  it("conditional final ('if tests pass I am done') -> UNVERIFIED", () => {
    const r = extractFinalClaim({ finalSummary: "if tests pass I am done" });
    expect(r.claim).toBe("UNVERIFIED");
  });

  it("REGRESSION F-08: narration 'success' + final 'the task failed' -> FAILURE (never FALSE_SUCCESS)", () => {
    const withNarration = extractFinalClaim({
      finalSummary: "the task failed",
      narrative: ["step 1 success", "step 2 success, everything ok"],
    });
    const withoutNarration = extractFinalClaim({ finalSummary: "the task failed" });
    expect(withNarration).toEqual(withoutNarration);
    expect(withNarration.claim).toBe("FAILURE");
    expect(withNarration.source).toBe("final-summary");
  });

  it("narrative never changes the verdict regardless of content", () => {
    const base = extractFinalClaim({ finalSummary: "created the report" });
    const poisoned = extractFinalClaim({
      finalSummary: "created the report",
      narrative: ["success success success"],
    });
    expect(poisoned).toEqual(base);
    expect(base.claim).toBe("SUCCESS");
  });
});

describe("successClaimText / isFailureClaim (safe substitutes)", () => {
  it("accepts explicit outcome text from a claim surface", () => {
    expect(successClaimText("I successfully fixed it")).toBe(true);
    expect(successClaimText("ho creato il file")).toBe(true);
    expect(successClaimText("tests pass")).toBe(true);
  });

  it("rejects narration-style, future, conditional and negated text", () => {
    expect(successClaimText("I'll make it succeed later")).toBe(false);
    expect(successClaimText("if it works, great")).toBe(false);
    expect(successClaimText("not successful")).toBe(false);
    expect(successClaimText('citing "success" from the spec')).toBe(false);
    expect(successClaimText("done maybe")).toBe(false);
    expect(successClaimText("")).toBe(false);
  });

  it("isFailureClaim matches explicit failure only", () => {
    expect(isFailureClaim("not successful")).toBe(true);
    expect(isFailureClaim("fallito")).toBe(true);
    expect(isFailureClaim("I successfully fixed it")).toBe(false);
    expect(isFailureClaim("I have not verified this yet")).toBe(false);
  });
});
