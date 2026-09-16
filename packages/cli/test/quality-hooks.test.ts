/** quality-hooks tests (CLI layer): artifact filtering and gap formatting. */
import { describe, expect, it } from "vitest";
import { auditClaimedArtifacts, findingsToGaps } from "../src/quality-hooks";

const files: Record<string, string> = {
  "tests/test_ok.py": "def test_a():\n    assert 1 + 1 == 2\n",
  "tests/test_fake.py": "def test_b():\n    assert True\n",
  "src/main.py": 'print("not a test")\n',
};
const fakeReader = (p: string): string | null => files[p] ?? null;

describe("auditClaimedArtifacts", () => {
  it("filters out non-test artifacts", () => {
    const findings = auditClaimedArtifacts(["src/main.py"], fakeReader);
    expect(findings).toHaveLength(0);
  });

  it("audits test-like artifacts and reports blocking findings", () => {
    const findings = auditClaimedArtifacts(["tests/test_ok.py", "tests/test_fake.py"], fakeReader);
    const blocking = findings.filter((f) => f.severity === "blocking");
    expect(blocking.some((f) => f.pattern === "assert-true")).toBe(true);
  });
});

describe("findingsToGaps", () => {
  it("formats blocking findings as repair gaps and drops warnings", () => {
    const findings = auditClaimedArtifacts(["tests/test_fake.py"], fakeReader);
    const gaps = findingsToGaps(findings);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]).toMatch(/Evidence audit \[assert-true\] tests\/test_fake\.py:\d/);
  });
});
