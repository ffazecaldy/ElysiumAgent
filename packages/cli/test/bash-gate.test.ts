/** bash-gate tests: verdict→action mapping, undefined policy passthrough,
 * env collection cap/min-length. Pure module — nothing executes here. */
import { describe, expect, it } from "vitest";
import { collectEnvSecretValues, gateBashCommand } from "../src/bash-gate";
import type { BashCommandPolicy } from "../src/policy/bash-policy";

const openPolicy: BashCommandPolicy = {
  denied: [],
  writableRoots: ["/repo"],
  networkAllowed: false,
};

describe("gateBashCommand", () => {
  it("runs everything when the policy is undefined (explicit opt-out)", () => {
    expect(gateBashCommand(undefined, "curl http://x", "/repo").action).toBe("RUN");
    expect(gateBashCommand(undefined, "rm -rf /", "/repo").action).toBe("RUN");
  });

  it("maps DENY verdicts to BLOCK with the policy reason", () => {
    const net = gateBashCommand(openPolicy, "curl https://example.com", "/repo");
    expect(net.action).toBe("BLOCK");
    expect(net.reason).toContain("network");

    const rm = gateBashCommand(openPolicy, "rm -rf /repo/build", "/repo");
    expect(rm.action).toBe("BLOCK");
    expect(rm.reason).toContain("rm");

    const redirect = gateBashCommand(openPolicy, "echo hi > /etc/hosts", "/repo");
    expect(redirect.action).toBe("BLOCK");
    expect(redirect.reason).toContain("write outside writable roots");
  });

  it("maps REQUIRE_APPROVAL verdicts to APPROVE", () => {
    const policy: BashCommandPolicy = { ...openPolicy, allowed: ["pytest", "npm"] };
    const decision = gateBashCommand(policy, "python -m build", "/repo");
    expect(decision.action).toBe("APPROVE");
    expect(decision.reason).toContain("allowed");
  });

  it("maps ALLOW verdicts to RUN", () => {
    expect(gateBashCommand(openPolicy, "pytest -q", "/repo").action).toBe("RUN");
    expect(gateBashCommand(openPolicy, "npm run build", "/repo").action).toBe("RUN");
  });

  it("checks every chain segment", () => {
    expect(gateBashCommand(openPolicy, "npm test && curl http://x", "/repo").action).toBe("BLOCK");
  });
});

describe("collectEnvSecretValues", () => {
  it("keeps only string values with length >= 8", () => {
    const values = collectEnvSecretValues({
      SHORT: "abc",
      EMPTY: "",
      NUMERIC: 42 as unknown as string,
      REAL: "hunter2hunter2",
    });
    expect(values).toEqual(["hunter2hunter2"]);
  });

  it("caps the collection at 200 values", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 300; i++) {
      big[`K${i}`] = `value-${i}-xxxxxxxx`;
    }
    expect(collectEnvSecretValues(big)).toHaveLength(200);
  });
});
