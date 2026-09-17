/** RedactingEvidenceChain: secrets never reach the evidence chain. */
import { EvidenceChain } from "@elysium/core";
import { describe, expect, it } from "vitest";
import { wrapEvidenceChain } from "../src/redacting-evidence";

describe("RedactingEvidenceChain", () => {
  it("redacts builtin secret patterns in summary and data before storing", () => {
    const chain = wrapEvidenceChain(new EvidenceChain("run-1"));
    chain.add("attempt", "T1", "ran with key sk-abcdefghijklmnop", {
      stdout: `token ghp_${"x".repeat(30)}`,
    });
    const [entry] = chain.entries();
    expect(entry?.summary).not.toContain("sk-abcdefghijklmnop");
    expect(entry?.summary).toContain("***REDACTED:openai_api_key***");
    const data = entry?.data as { stdout?: string } | undefined;
    expect(data?.stdout).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(data?.stdout).toContain("***REDACTED:github_token***");
  });

  it("redacts exact extraValues (loaded env)", () => {
    const chain = wrapEvidenceChain(new EvidenceChain("run-2"), ["hunter2hunter2"]);
    chain.add("critic", "T1", "password hunter2hunter2 leaked");
    const [entry] = chain.entries();
    expect(entry?.summary).toBe("password ***REDACTED:VALUE*** leaked");
  });

  it("passes through clean entries untouched and keeps the chain surface", () => {
    const inner = new EvidenceChain("run-3");
    const chain = wrapEvidenceChain(inner);
    chain.add("gate", "T2", "gate passed", { risk: "low" });
    chain.add("task_ended", "T2", "task done");
    expect(chain.entries()).toHaveLength(2);
    expect(chain.byTask("T2")).toHaveLength(2);
    expect(chain.toJSON().runId).toBe("run-3");
    expect(inner.entries()).toHaveLength(2); // same underlying entries
  });
});
