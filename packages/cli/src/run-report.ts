/**
 * Run Report — human-readable, ANSI-free summary of a completed run.
 *
 * Pure string assembly on top of the observability helpers
 * (`renderRunTimeline`, `whyFailed`, `renderProvenance`). No I/O, no ANSI
 * escapes; `buildRunReport` never throws and always returns a string, even
 * for partially malformed input.
 */

import {
  type ArtifactProvenance,
  type PhaseStat,
  renderProvenance,
  renderRunTimeline,
  whyFailed,
} from "./observability";

/** Final status of a run, as reported in the report header. */
export type RunStatus = "COMPLETED" | "FAILED" | "INTERRUPTED";

/** Everything `buildRunReport` needs to render a run summary. */
export interface RunReportInput {
  runId: string;
  goal: string;
  status: RunStatus;
  phases: PhaseStat[];
  /** Root cause of the failure; only meaningful when `status` is "FAILED". */
  failureCause?: string | null;
  /** Bullet details shown under the failure cause (FAILED runs only). */
  failureDetails?: string[];
  /** Provenance records of the artifacts produced by the run. */
  artifacts?: ArtifactProvenance[];
  /** Evidence gate status (e.g. "PASSED" / "MISSING"), or null when absent. */
  evidenceStatus?: string | null;
}

/** Fixed section titles of the report. */
const SECTION_FAILURE = "WHY DID THIS RUN FAIL";
const SECTION_PROVENANCE = "PROVENANCE";
const SECTION_EVIDENCE = "EVIDENCE";

function section(title: string, body: string[]): string[] {
  return [title, ...body, ""];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Build the full run report as a multi-line string:
 *
 * ```text
 * RUN REPORT
 * run: <runId>
 * goal: <goal>
 * status: <status>
 *
 * TIMELINE
 * <renderRunTimeline output>
 *
 * WHY DID THIS RUN FAIL     <- only when status === "FAILED"
 * <whyFailed output>
 *
 * PROVENANCE                <- only when at least one artifact is present
 * <renderProvenance per artifact>
 *
 * EVIDENCE
 * status: <evidenceStatus or "(none)">
 * ```
 *
 * Never throws: missing/ill-typed fields degrade to safe defaults and every
 * optional section is skipped when its input is absent.
 */
export function buildRunReport(input: RunReportInput): string {
  const runId = asString(input?.runId, "(unknown run)");
  const goal = asString(input?.goal, "(no goal)");
  const status = asString(input?.status, "INTERRUPTED");
  const phases = Array.isArray(input?.phases) ? input.phases : [];

  const lines: string[] = ["RUN REPORT", `run: ${runId}`, `goal: ${goal}`, `status: ${status}`, ""];

  // TIMELINE — always rendered (possibly empty table for zero phases).
  lines.push(...section("TIMELINE", [renderRunTimeline(phases)]));

  // WHY DID THIS RUN FAIL — only for FAILED runs. whyFailed already emits
  // its own header; it returns "" when there are no details, so fall back to
  // a cause-only block to keep the section present with the cause line.
  if (status === "FAILED") {
    const cause = asString(input?.failureCause, "(unknown cause)");
    const details = Array.isArray(input?.failureDetails)
      ? input.failureDetails.filter((detail): detail is string => typeof detail === "string")
      : [];
    const body = whyFailed(cause, details);
    lines.push(
      ...(body === "" ? section(SECTION_FAILURE, [`Cause: ${cause}`]) : section(body, [])),
    );
  }

  // PROVENANCE — one rendered block per artifact.
  const artifacts = Array.isArray(input?.artifacts) ? input.artifacts : [];
  if (artifacts.length > 0) {
    const blocks = artifacts.map((artifact) => renderProvenance(artifact));
    lines.push(...section(SECTION_PROVENANCE, blocks.join("\n\n").split("\n")));
  }

  // EVIDENCE — always rendered; absent status degrades to "(none)".
  const evidence = asString(input?.evidenceStatus, "(none)");
  lines.push(...section(SECTION_EVIDENCE, [`status: ${evidence}`]));

  return lines.join("\n").replace(/\n+$/, "\n").trimEnd();
}
