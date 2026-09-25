import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../src/policy/bash-policy";

const pol = {
  denied: ["rm -rf", "git reset --hard", "git push", "sudo", "powershell -enc"],
  writableRoots: ["/ws"],
  networkAllowed: false,
};

describe("F-06b regression — destructive find/-delete and mv path-state mutation", () => {
  // ── direct ────────────────────────────────────────────────────────
  it("find <dir> -delete is approval-form (all flag positions)", () => {
    for (const cmd of [
      "find src -delete",
      "find src -depth -delete",
      "find -delete src",
      "find . -name '*.ts' -delete",
    ]) {
      expect(checkBashCommand(pol, cmd, "/ws").verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  // ── embedded primaries ────────────────────────────────────────────
  it("find with -type/-name primaries + -delete is approval-form", () => {
    for (const cmd of [
      "find src -type f -delete",
      "find src -type d -delete",
      "find src -name '*.tmp' -delete",
      "find src -type f -name '*.log' -delete",
    ]) {
      expect(checkBashCommand(pol, cmd, "/ws").verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  // ── composition: mv + destructive follow-up ───────────────────────
  it("mv relocating a workspace path is approval-form (and composes with find)", () => {
    for (const cmd of [
      "mv src src.removed-backup",
      "mv src src.removed-backup && find src.removed-backup -delete",
      "mv src nested/path/",
      "mv dir /other/path",
    ]) {
      const v = checkBashCommand(pol, cmd, "/ws");
      expect(["REQUIRE_APPROVAL", "DENY"]).toContain(v.verdict);
    }
  });

  // ── non-bypass: benign usages stay allowed ────────────────────────
  it("non-destructive find stays allowed", () => {
    for (const cmd of ["find src -print", "find src -type f", "find src -name '*.tmp'"]) {
      expect(checkBashCommand(pol, cmd, "/ws").verdict).toBe("ALLOW");
    }
  });

  it("'-delete' as data (echo/quoted text) is NOT flagged", () => {
    expect(checkBashCommand(pol, "echo -delete", "/ws").verdict).toBe("ALLOW");
    expect(checkBashCommand(pol, 'echo "-delete"', "/ws").verdict).toBe("ALLOW");
    expect(checkBashCommand(pol, "cat docs/-delete.md", "/ws").verdict).toBe("ALLOW");
  });

  it("mv cross-root stays a hard DENY (stronger verdict preserved)", () => {
    const v = checkBashCommand(pol, "mv src /outside/path", "/ws");
    expect(v.verdict).toBe("DENY");
  });

  it("mv -t/--target forms are flagged too", () => {
    expect(checkBashCommand(pol, "mv -t /ws/dst src", "/ws").verdict).toBe("REQUIRE_APPROVAL");
  });

  // ── same-class variants (audit §11) ───────────────────────────────
  it("already-covered same-class vectors remain blocked (no regression)", () => {
    for (const cmd of [
      "find src -exec rm -rf {} +",
      "find src -execdir rm -rf {} +",
      "echo src | xargs rm -rf",
      "busybox rm -rf src",
      "bash -c 'rm -rf src'",
    ]) {
      const v = checkBashCommand(pol, cmd, "/ws");
      expect(["REQUIRE_APPROVAL", "DENY"]).toContain(v.verdict);
    }
  });
});
