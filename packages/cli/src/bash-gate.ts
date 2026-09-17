/**
 * packages/cli/src/bash-gate.ts — the runtime bash boundary.
 *
 * Every bash execution in Elysium goes through this gate BEFORE spawn:
 * the swarm loop (executeTool) and the REPL loop both call
 * {@link gateBashCommand}; there is no other path that can run a shell
 * command. Nothing in this module executes anything.
 */

import { type BashCommandPolicy, checkBashCommand } from "./policy/bash-policy";

/** Outcome of the gate check for one command. */
export type BashGateAction = "RUN" | "BLOCK" | "APPROVE";

/** Result of {@link gateBashCommand}. */
export interface BashGateDecision {
  action: BashGateAction;
  reason?: string;
}

/**
 * Map a policy verdict to a runtime action. `policy === undefined` means the
 * operator disabled the gate → RUN (backward compatible, explicit choice).
 * DENY and REQUIRE_APPROVAL are decided by the policy; the gate itself never
 * executes anything.
 */
export function gateBashCommand(
  policy: BashCommandPolicy | undefined,
  command: string,
  cwd: string,
): BashGateDecision {
  if (policy === undefined) {
    return { action: "RUN" };
  }
  const verdict = checkBashCommand(policy, command, cwd);
  if (verdict.verdict === "DENY") {
    return { action: "BLOCK", reason: verdict.reason };
  }
  if (verdict.verdict === "REQUIRE_APPROVAL") {
    return { action: "APPROVE", reason: verdict.reason };
  }
  return { action: "RUN" };
}

/**
 * One-time-per-run collection of env values for exact-value redaction.
 * String values only, length ≥ 8, capped — the boundary cost is paid once.
 */
export function collectEnvSecretValues(source: NodeJS.ProcessEnv = process.env): string[] {
  const values = Object.values(source).filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  );
  return values.slice(0, 200);
}
