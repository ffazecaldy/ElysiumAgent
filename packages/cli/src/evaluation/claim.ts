/**
 * packages/cli/src/evaluation/claim.ts — F-08 final-claim extraction.
 *
 * / Estrazione del claim finale (F-08): SOLO il riepilogo finale dell'assistente
 * / è superficie claim; la narrativa intermedia è IGNORATA.
 *
 * PURE: extractFinalClaim() is deterministic — no I/O, no clock, no model.
 *
 * F-08 bug this fixes: the evaluator matched SUCCESS_CLAIM_RE
 * (/success|succeeded|ok|completato/i) on ANY claim string, so an
 * intermediate narration like "I'll verify it succeeds later" produced a
 * FALSE_SUCCESS. Here the claim surface is ONLY the final assistant summary
 * (plus the harness status as a weaker fallback); `narrative` is accepted in
 * the input purely for call-site compatibility and NEVER inspected.
 *
 * Deterministic rules, in order (first match wins):
 * 1. future / promise  ("will verify", "implementerò", "verificherò", "farò") → UNVERIFIED
 * 2. conditional       ("if it works", "se funziona", "unless")              → UNVERIFIED
 * 3. hedge             ("maybe", "perhaps", "forse", "possibilmente")        → NONE (ambiguous)
 * 4. unverified check  ("not verified (yet)", "non verificato")              → UNVERIFIED
 * 5. negation/failure  ("not successful", "non riuscito", "could not
 *                       complete", "failed", "fallito")                      → FAILURE
 * 6. explicit outcome  ("created", "fixed", "ho creato", "tests pass",
 *                       "completato")                                        → SUCCESS
 * 7. empty / nothing matched                                                 → NONE
 *
 * Quoted mentions («"success" citato tra virgolette») are stripped before
 * matching: citing the word is not claiming the outcome.
 */

/** Deterministic claim verdict for the final assistant summary. */
export type ClaimVerdict = "SUCCESS" | "FAILURE" | "UNVERIFIED" | "NONE";

/** Where the extracted claim came from. `narrative` can never appear here. */
export type ClaimSource = "final-summary" | "status" | "none";

/** The pure result of one claim-extraction pass. */
export interface FinalClaim {
  claim: ClaimVerdict;
  /** Rule strength: 0.9 explicit outcome, 0.75 unverified, 0.6 status-only, 0.4 ambiguous. */
  confidence: number;
  source: ClaimSource;
}

/** Input shape. `narrative` is deliberately present-and-ignored (F-08). */
export interface FinalClaimInput {
  finalSummary: string | null;
  status?: string;
  /** Intermediate narration — IGNORED for the claim. Never a claim surface. */
  narrative?: string[];
}

/** Future/promise phrasing: intent, not outcome. */
const FUTURE_RE =
  /\bwill\b|\bgoing to\b|\b(?:i|we|he|she|they)\s*['’]ll\b|\blater\b|\bnext\s+step\b|implementer[òo]|verificher[òo]|prover[òo]|\bfar[òo]\b|successivamente|in\s+seguito/i;

/** Conditional phrasing: outcome gated on something else. */
const CONDITIONAL_RE =
  /\bif\b|\bunless\b|\bassuming\b|\bin\s+case\b|\bqualora\b|\bnel\s+caso\b|\bse\s+(?:funziona|passa|funzionano)\b|\bse\s+funziona\b/i;

/** Hedges: even a real keyword under a hedge is ambiguous, never a claim. */
const HEDGE_RE =
  /\bmaybe\b|\bperhaps\b|\bpossibly\b|\bmight\b|\bforse\b|\bprobabilmente\b|\bpossibilmente\b/i;

/** Negated verification: nothing was checked yet — not a failure. */
const NOT_VERIFIED_RE =
  /\bnot\s+(?:been\s+)?verif(?:ied|y|ies)\b|\bhaven'?t\s+verified\b|\bhasn'?t\s+been\s+verified\b|\byet\s+to\s+verif(?:y|ied)\b|\bnot\s+(?:been\s+)?tested\b|\bnon\s+(?:ancora\s+)?verificat[oa]\b|\bnon\s+verificat[oa]\b/i;

/** Negation / explicit failure: a claimed negative outcome. */
const FAILURE_RE =
  /\bnot\s+successful\b|\bnot\s+succeed(?:ed)?\b|\bnot\s+complete[dt]?\b|\bcould\s?n['’]?t\b|\bcould\s+not\b|\bunable\s+to\b|\bwas\s+not\s+able\b|\bdid\s+n['’]?t\s+(?:work|complete|succeed)\b|\bfailed\b|\bfailure\b|\bfallit[oa]\b|\bnon\s+riuscit[oa]\b|\bnon\s+completat[oa]\b|\bimpossibile\s+completare\b/i;

/** Explicit past/present successful outcome. */
const SUCCESS_RE =
  /\bsuccess(?:ful|fully)?\b|\bsucceed(?:ed)?\b|\bcreated\b|\bfixed\b|\bcompleted\b|\btests?\s+(?:pass|passed|passing)\b|\ball\s+passing\b|\bpassing\b|\bworks?\b(?:\s+now\b)?|\bcompletat[oa]\b|\bho\s+creato\b|\bho\s+corretto\b|\brisolt[oa]\b|\bfunziona\b/i;

/** Quoted segments are citations, not claims — stripped before matching. */
const QUOTED_RE = /"[^"]*"|“[^”]*”|„[^“”]*“|«[^»]*»|`[^`]*`/g;

/** Classify one claim-surface text with the deterministic rule order. */
function classifyClaimText(text: string): ClaimVerdict {
  const raw = typeof text === "string" ? text : "";
  if (raw.trim().length === 0) return "NONE";
  // Citing a keyword inside quotes is not claiming the outcome.
  const stripped = raw.replace(QUOTED_RE, " ");
  if (stripped.trim().length === 0) return "NONE";
  if (FUTURE_RE.test(stripped)) return "UNVERIFIED";
  if (CONDITIONAL_RE.test(stripped)) return "UNVERIFIED";
  if (HEDGE_RE.test(stripped)) return "NONE";
  if (NOT_VERIFIED_RE.test(stripped)) return "UNVERIFIED";
  if (FAILURE_RE.test(stripped)) return "FAILURE";
  if (SUCCESS_RE.test(stripped)) return "SUCCESS";
  return "NONE";
}

/** Strict harness-status vocabulary (the status is not free narration). */
const STATUS_SUCCESS_RE = /^(?:completed|complete|success|succeeded|ok|passed|pass|done)\.?$/i;
const STATUS_FAILURE_RE = /^(?:failed|failure|error|aborted|cancelled|canceled|timeout)\.?$/i;

/**
 * Extract the final claim from the run's final surfaces. ONLY `finalSummary`
 * (and, as a weaker fallback, `status`) is inspected; `narrative` is ignored
 * so intermediate "success" mentions can never yield FALSE_SUCCESS (F-08).
 */
export function extractFinalClaim(input: FinalClaimInput): FinalClaim {
  const summary = typeof input?.finalSummary === "string" ? input.finalSummary : "";
  if (summary.trim().length > 0) {
    const claim = classifyClaimText(summary);
    const confidence =
      claim === "SUCCESS" || claim === "FAILURE" ? 0.9 : claim === "UNVERIFIED" ? 0.75 : 0.4;
    return { claim, confidence, source: "final-summary" };
  }

  const status = typeof input?.status === "string" ? input.status.trim() : "";
  if (status.length > 0) {
    if (STATUS_SUCCESS_RE.test(status)) {
      return { claim: "SUCCESS", confidence: 0.6, source: "status" };
    }
    if (STATUS_FAILURE_RE.test(status)) {
      return { claim: "FAILURE", confidence: 0.6, source: "status" };
    }
    return { claim: "NONE", confidence: 0.4, source: "status" };
  }

  return { claim: "NONE", confidence: 0, source: "none" };
}

/**
 * Safe substitute for the old permissive SUCCESS_CLAIM_RE matching: accepts
 * ONLY text taken from a claim surface (final summary / status). Never feed
 * narration here. True only for an explicit, unhedged, unquoted,
 * non-negated success outcome.
 */
export function successClaimText(text: string): boolean {
  return classifyClaimText(text) === "SUCCESS";
}

/** True only for an explicit claimed failure (negation / "failed"). */
export function isFailureClaim(text: string): boolean {
  return classifyClaimText(text) === "FAILURE";
}
