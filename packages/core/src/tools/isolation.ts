/**
 * Network-isolation seam for the bash tool (SUBAGENT D audit deliverable).
 *
 * AUDIT VERDICT (benchmarks/capability/network-isolation-audit.md): on
 * Windows, Node's child_process cannot create a network-isolated child
 * without admin-driven firewall rules, a token/job broker or a driver.
 * This seam exists so a future broker (firewall-rule broker, AppContainer
 * launcher) can be plugged in WITHOUT changing the tool contract — and so
 * the current behavior (no OS-level network isolation) is explicit instead
 * of implicit.
 */

/** Spawn options bash.ts passes to child_process.exec (isolation-relevant subset). */
export interface BashSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  maxBuffer: number;
}

/**
 * Hook that rewrites bash child spawn options to enforce network isolation.
 * Implementations MUST be fail-safe: on any uncertainty they must narrow (or
 * refuse the spawn), never widen, what the child can reach.
 */
export interface NetworkIsolationProvider {
  /** True when this platform/runtime can actually isolate a child today. */
  available(): boolean;
  /**
   * Returns child spawn options with network isolation applied. `workspace`
   * is the tool working directory the child will run in.
   */
  isolate(childOptions: BashSpawnOptions, workspace: string): Promise<BashSpawnOptions>;
  /** Human-readable description used in telemetry and the per-spawn env marker. */
  describe(): string;
}

/**
 * Current behavior, made explicit: NO OS-level network isolation. Children
 * run under the inherited user token with full network reach; the only
 * network enforcement is the upstream command policy (bash-policy.ts
 * deny/approve), which is hardening, NOT isolation. A marker env var
 * (ELYSIUM_NETWORK_ISOLATION) is added so any run can assert which
 * isolation regime its bash children actually executed under.
 */
export class NullIsolationProvider implements NetworkIsolationProvider {
  available(): boolean {
    return false;
  }

  async isolate(childOptions: BashSpawnOptions, _workspace: string): Promise<BashSpawnOptions> {
    return {
      ...childOptions,
      env: { ...childOptions.env, ELYSIUM_NETWORK_ISOLATION: this.describe() },
    };
  }

  describe(): string {
    return "no OS-level network isolation";
  }
}
