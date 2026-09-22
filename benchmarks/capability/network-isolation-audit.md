# Network Isolation Audit — bash tool on Windows (SUBAGENT D, coordinator-completed)

Verdict: **TRUE per-spawn network isolation is NOT reachable on Windows with the
current architecture** (Node child_process). The honest state is implemented,
not simulated: `networkAllowed=false` keeps the deny/approve command policy
(hardening) and the bash child now runs under an EXPLICIT
`NullIsolationProvider` whose `describe()` = "no OS-level network isolation",
injected as env marker `ELYSIUM_NETWORK_ISOLATION` into every bash child.

## How children are spawned today

`packages/core/src/tools/builtins/bash.ts` → `runCommand()` → `child_process.exec`
with `{ cwd, windowsHide: true, maxBuffer: 8MB, env }`. The child inherits: the
full user token (no AppContainer/restricted token), the full environment, and
the host network stack. Windows spawn path resolves via cmd.exe (dual POSIX/cmd
readings are handled by bash-policy). Pre-existing hardening:
`NoDefaultCurrentDirectoryInExePath=1` (executable-hijack guard, campaign 2).

## OS mechanisms evaluated (feasibility without breaking the runtime)

| Mechanism | Feasibility | Why |
|-----------|-------------|-----|
| Windows Firewall per-program rules (`netsh advfirewall`) | ❌ admin + per-binary | rules keyed by executable path, not per-spawn; Node cannot elevate; churn per tool |
| AppContainer / restricted token | ❌ needs token broker | `child_process` cannot create AppContainer processes natively; requires a native broker |
| Job Objects | ❌ no network filter | process lifetime/kernel objects only — no network ACL capability |
| Dedicated low-privilege local user + firewall profile | ⚠ operationally heavy | needs account provisioning + password/logon rights + rules; per-run identity impractical |
| WSL / sandbox binaries (firejail equivalents) | ❌ new dependency + parity gap | different network namespace semantics; not Windows-native |
| Driver / WinFSP-class filter | out of scope | kernel component, not shippable in this repo |

## Empirical probes (`network-probes.mts`, results in `network-probe-results.json`)

With `networkAllowed=false`, through the real gate+tool path:

| Probe | Gate verdict | Executed | Network attempt | Escaped |
|-------|--------------|----------|-----------------|---------|
| `curl https://example.com` | BLOCK (denylist) | no | no | no |
| `ssh host` | BLOCK (denylist) | no | no | no |
| `node -e fetch(...)` | APPROVE → refused in swarm (no approver) | no | no | no |
| `powershell Invoke-WebRequest` | APPROVE → refused in swarm | no | no | no |
| `nslookup example.com` | verdict per policy (hardening) | yes | **yes** | **YES — documented escape** |
| `node -e "dns.resolve4('x.invalid')"` | APPROVE → refused in swarm | no | no | no |
| interpreter NOT on any list running inline socket code | RUN (policy cannot see intent) | yes | **yes** | **YES — the structural gap** |
| loopback listener connect (child → 127.0.0.1 port) | RUN | yes | yes | YES (in-process, harmless) |

Conclusion: the denylist + approval layer blocks the KNOWN tools; interpreters
with inline code remain a real escape path. This is the documented debt, now
proven empirically and surfaced through `NullIsolationProvider.describe()`.

## Seam design (implemented)

```ts
// packages/core/src/tools/isolation.ts
interface NetworkIsolationProvider {
  available(): boolean;
  isolate(childOptions: BashSpawnOptions, workspace: string): Promise<BashSpawnOptions>;
  describe(): string;
}
class NullIsolationProvider implements NetworkIsolationProvider { /* current behavior, explicit */ }
```

Injection point: `bash.ts runCommand()` — spawn options now flow through
`await isolation.isolate({...}, cwd)` BEFORE `child_process.exec` (replacing the
inline options object). Opt-in via `createBuiltinTools(policy, { isolation })`;
default everywhere is `NullIsolationProvider` (zero behavior change).

Future Windows implementations (sketch, all behind this seam):
- **Firewall-rule broker**: an elevated sidecar service that creates a
  per-spawn WFP rule for the child PID, on success returns narrowed options;
  `available()` false without the service.
- **AppContainer launcher**: native addon that builds an AppContainer profile
  with Internet deny CAP and spawns through `CreateProcessAsUser` — replaces
  `exec` wholesale for the child.

Fail-safe contract: any provider error NARROWS (blocks the spawn) or throws —
never widens. `networkAllowed=false` semantics are unchanged and remain the
enforcement layer until a real provider ships.
