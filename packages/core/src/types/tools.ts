/**
 * Tool system types.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */
import type { JsonSchema } from "./content";
import type { HarnessEvent } from "./events";

export interface ToolContext {
  /** Working directory the tool operates in. */
  cwd: string;
  signal: AbortSignal;
  /** Tools may emit progress/telemetry events. */
  emit(event: HarnessEvent): void;
  /**
   * Optional operator approval gate. When defined, tools whose policy
   * evaluation flags the operation (e.g. bash warnCommands) must await this
   * callback before executing; a `false` result cancels the operation and
   * yields an isError tool result. Absent means no approval is required.
   */
  confirm?: (command: string) => Promise<boolean>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  /** Optional structured details for the session log / telemetry. */
  details?: unknown;
}

export interface Tool<P = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: P, ctx: ToolContext): Promise<ToolResult>;
}

/** Security policy for filesystem and bash tools. */
export interface PathPolicy {
  /** Filesystem tools may only touch paths inside these roots (resolved absolute). */
  allowedRoots: string[];
  /** Bash: commands matching these patterns are rejected. */
  deniedCommands?: string[];
  /** Bash: commands matching these patterns are allowed but flagged in telemetry. */
  warnCommands?: string[];
}
