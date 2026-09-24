/**
 * F-05 network/DNS policy tests: dedicated DNS tools (nslookup / dig / host)
 * under `networkAllowed: false`.
 *
 * // RED until parent integrates NETWORK_COMMANDS += nslookup|dig|host
 *
 * TARGET behaviour documented here (see bash-policy.ts, NETWORK_COMMANDS):
 * with network=false the DNS tools must be DENIED in every statically visible
 * form — bare base command, absolute/relative path-qualified invocation,
 * Windows `.exe` suffix, pass-through wrappers (`command`, `env`, `exec`,
 * `timeout`), case variations, and as one segment of a chain. The wrapper
 * forms are the actual RED cases today: the standalone DNS_COMMANDS check in
 * bash-policy.ts inspects only the segment head, so `command nslookup x` &
 * co. currently ALLOW. Folding nslookup/dig/host into NETWORK_COMMANDS —
 * whose deny check runs against the wrapper-canonicalized base — closes the
 * gap. The expected DENY reason once integrated is the network family one
 * (`network command not allowed: <base>`); until then the standalone check
 * denies the head forms with `DNS command not allowed: <base>`. This suite
 * pins verdicts only (verdict + network-ish reason), not exact reason text.
 *
 * network=true → ALLOW: the REPL is expected to keep DNS tooling usable.
 *
 * ─── EXPLICIT LIMITATION (do not mistake this for a sandbox) ────────────────
 * `networkAllowed: false` is a COMMAND POLICY ONLY. It is static string
 * analysis of the command line: it denies known network binaries by name and
 * fails safe (unknown spellings, uncached lookups, future tools may pass).
 * It is NOT OS-level network isolation: it does not create a namespace, does
 * not filter sockets, and cannot block DNS performed in-process by library
 * code — e.g. `node -e "require('dns').resolve(...)"` or a fetch() inside an
 * approved script makes DNS queries that no command-name policy can see.
 * Nothing here should be read as claiming sandbox guarantees.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../src/policy/bash-policy";

const noNetworkPolicy = {
  denied: [],
  writableRoots: ["C:/tmp/ws"],
  networkAllowed: false,
};

const networkPolicy = {
  denied: [],
  writableRoots: ["C:/tmp/ws"],
  networkAllowed: true,
};

describe("F-05 DNS tools: networkAllowed=false → DENY", () => {
  it("denies bare base commands", () => {
    for (const cmd of ["nslookup example.com", "dig example.com", "host example.com"]) {
      const result = checkBashCommand(noNetworkPolicy, cmd);
      expect(result.verdict, cmd).toBe("DENY");
      expect(result.reason?.toLowerCase(), cmd).toContain("not allowed");
    }
  });

  it("denies path-qualified invocations (POSIX and Windows)", () => {
    for (const cmd of [
      "/usr/bin/nslookup example.com",
      "/usr/bin/dig example.com",
      "/usr/bin/host example.com",
      "./nslookup example.com",
      "C:/Windows/System32/nslookup.exe example.com",
    ]) {
      const result = checkBashCommand(noNetworkPolicy, cmd);
      expect(result.verdict, cmd).toBe("DENY");
    }
  });

  it("denies the Windows .exe spelling", () => {
    for (const cmd of ["nslookup.exe example.com", "dig.exe example.com", "host.exe example.com"]) {
      expect(checkBashCommand(noNetworkPolicy, cmd).verdict, cmd).toBe("DENY");
    }
  });

  it("denies through pass-through wrappers (command/env/exec/timeout) — RED until NETWORK_COMMANDS integration", () => {
    for (const cmd of [
      "command nslookup example.com",
      "env nslookup example.com",
      "exec nslookup example.com",
      "timeout 5 nslookup example.com",
      "command dig example.com",
      "env dig example.com",
      "timeout 5 dig example.com",
      "command host example.com",
      "env host example.com",
      "timeout 5 host example.com",
    ]) {
      const result = checkBashCommand(noNetworkPolicy, cmd);
      expect(result.verdict, cmd).toBe("DENY");
    }
  });

  it("denies case variations", () => {
    for (const cmd of ["NSLOOKUP example.com", "Dig example.com", "HOST example.com"]) {
      expect(checkBashCommand(noNetworkPolicy, cmd).verdict, cmd).toBe("DENY");
    }
  });

  it("denies DNS tools as one segment of a chain", () => {
    for (const cmd of [
      "nslookup example.com && echo ok",
      "echo hi && dig example.com",
      "host example.com; ls",
    ]) {
      expect(checkBashCommand(noNetworkPolicy, cmd).verdict, cmd).toBe("DENY");
    }
  });

  it("never false-positives on lookalike names", () => {
    // Token-aware matching: these are NOT the DNS tools.
    for (const cmd of ["nslookupx example.com", "echo nslookup example.com"]) {
      expect(checkBashCommand(noNetworkPolicy, cmd).verdict, cmd).not.toBe("DENY");
    }
  });
});

describe("F-05 DNS tools: networkAllowed=true → ALLOW (REPL behaviour)", () => {
  it("allows the dedicated DNS tools when network is permitted", () => {
    for (const cmd of ["nslookup example.com", "dig example.com", "host example.com"]) {
      expect(checkBashCommand(networkPolicy, cmd).verdict, cmd).toBe("ALLOW");
    }
  });

  it("keeps the curl family allowed when network is permitted", () => {
    expect(checkBashCommand(networkPolicy, "curl https://example.com").verdict).toBe("ALLOW");
  });
});

/*
 * ─── F-05 PROBE EVIDENCE (real spawns, networkAllowed=false, 3s timeout) ────
 * Recorded by %LOCALAPPDATA%/Temp/elysium-probes/f05-network-probe.mts
 * (results: f05-network-probe-results.json). Each row: the POLICY verdict
 * vs. what happens when the command is spawned directly anyway:
 *
 *  cmd                    policyVerdict      executed?  observed
 *  nslookup localhost     DENY (DNS)         YES        resolved 127.0.0.1/::1 via the local router
 *  dig example.com        DENY (DNS)         no         ENOENT — bind tools absent on this Windows host
 *  host example.com       DENY (DNS)         no         ENOENT — idem
 *  curl https://…         DENY (network)     YES        fetched example.com, HTTP body received (exit 0)
 *  node -e "fetch(…)"     REQUIRE_APPROVAL   YES        inline-code approval gate, then real fetch, HTTP 200
 *
 * READING: a DENY verdict is advisory-at-enforcement-time. The bash gate
 * blocks the agent from ASKING to run these commands, but nothing here
 * enforces the block at the OS layer — spawned directly, nslookup and curl
 * performed real DNS/HTTP traffic. dig/host failed only because the binaries
 * are not installed (fail-INCIDENTAL, not fail-safe: on a host that has them
 * they would run exactly like nslookup did).
 *
 * FAIL-SAFE + LIMITATION, restated as contract:
 * 1. networkAllowed=false = COMMAND POLICY ONLY (static token analysis of the
 *    command line). It is NOT OS network isolation: no namespace, no socket
 *    filter, no firewall rule.
 * 2. DNS via in-process library code (node's `dns` module, fetch(), any
 *    runtime resolver) makes no command line and is UNBLOCKABLE at this
 *    layer — see the node -e probe: the request left the machine.
 * 3. Unknown spellings/aliases of network tools are not denied (fail-open by
 *    design; the deny list is an enumeration, not an interception).
 * 4. Therefore: no code path may describe networkAllowed=false as a
 *    "sandbox", "isolation", or "air gap". The honest claim is: the agent
 *    will not be offered these commands without approval.
 * CLOSING the wrapper gap (the RED test above) requires the parent to fold
 * nslookup/dig/host into NETWORK_COMMANDS, whose check already runs on the
 * wrapper-canonicalized base command.
 * ─────────────────────────────────────────────────────────────────────────────
 */
