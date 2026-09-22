/** bash-policy xargs tests (F-01): an `xargs` TARGET command must get the
 * exact same deny analysis as a direct command (`echo src | xargs rm -rf`
 * executed destructively while the gate returned RUN). Pure static analysis,
 * no real execution. */
import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../src/policy/bash-policy";

const openPolicy = {
  denied: [],
  writableRoots: ["/repo"],
  networkAllowed: false,
};

const BLOCK_CASES = [
  "xargs rm -rf src",
  "echo src | xargs rm -rf",
  "printf '%s\\n' src | xargs rm -rf",
  "cat list.txt | xargs rm -rf",
  "find . -type f | xargs rm -rf",
  "xargs -I{} rm -rf {}",
  "xargs -n 2 rm -rf x",
  "sudo xargs rm -rf src",
  "/usr/bin/xargs rm -rf src",
  "bash -c 'echo x | xargs rm -rf'",
  "xargs rm -rf src | wc -l",
];

const RUN_CASES = [
  "cat files.txt | xargs cat",
  "ls | xargs wc -l",
  "echo a b | xargs mkdir -p",
  "xargs echo",
  "xargs",
  "find . -name '*.log' | xargs cat",
  "xargs -I{} cp {} backup/",
];

describe("xargs target command analysis (F-01)", () => {
  it("denies destructive/denied xargs targets in every spelling", () => {
    for (const cmd of BLOCK_CASES) {
      const result = checkBashCommand(openPolicy, cmd);
      expect(result.verdict, `${cmd} -> ${result.verdict} (${result.reason ?? "-"})`).toBe("DENY");
    }
  });

  it("keeps benign xargs usage runnable", () => {
    for (const cmd of RUN_CASES) {
      const result = checkBashCommand(openPolicy, cmd);
      expect(result.verdict, `${cmd} -> ${result.verdict} (${result.reason ?? "-"})`).toBe("ALLOW");
    }
  });

  it("matches direct-command deny behavior (parity: recursive rm, git push)", () => {
    expect(checkBashCommand(openPolicy, "rm -rf src").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "xargs rm -rf src").verdict).toBe(
      checkBashCommand(openPolicy, "rm -rf src").verdict,
    );
    expect(checkBashCommand(openPolicy, "echo x | xargs git push origin main").verdict).toBe(
      checkBashCommand(openPolicy, "git push origin main").verdict,
    );
  });

  it("plain rm parity: xargs rm is exactly as permissive as direct rm", () => {
    const direct = checkBashCommand(openPolicy, "rm /repo/x.txt");
    // Non-recursive rm inside the writable roots is allowed directly today.
    expect(direct.verdict).toBe("ALLOW");
    const indirect = checkBashCommand(openPolicy, "echo /repo/x.txt | xargs rm /repo/x.txt");
    expect(indirect.verdict).toBe(direct.verdict);
  });
});
