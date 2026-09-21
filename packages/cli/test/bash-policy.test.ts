/** bash-policy tests (CLI layer): pure static analysis, no real execution. */
import { describe, expect, it } from "vitest";
import { checkBashCommand, extractRedirectTargets } from "../src/policy/bash-policy";

const openPolicy = {
  denied: [],
  writableRoots: ["/repo"],
  networkAllowed: false,
};

describe("network commands", () => {
  it("denies curl when networkAllowed=false", () => {
    const result = checkBashCommand(openPolicy, "curl https://example.com");
    expect(result.verdict).toBe("DENY");
    expect(result.reason).toContain("network");
  });

  it("denies wget, nc, ssh, ftp and telnet as base commands only", () => {
    for (const cmd of ["wget http://x", "nc -l 8080", "ssh host", "ftp host", "telnet host"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
    expect(checkBashCommand(openPolicy, "curlx https://example.com").verdict).toBe("ALLOW");
  });

  it("allows network commands when networkAllowed=true", () => {
    const result = checkBashCommand(
      { ...openPolicy, networkAllowed: true },
      "curl https://example.com",
    );
    expect(result.verdict).toBe("ALLOW");
  });
});

describe("deny list", () => {
  it("denies recursive rm in flag-bundle forms", () => {
    expect(checkBashCommand(openPolicy, "rm -rf /repo/build").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "rm -fr /repo/build").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "rm --recursive /repo/build").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "rm -r /repo/build").verdict).toBe("DENY");
  });

  it("allows non-recursive rm inside writable roots", () => {
    expect(checkBashCommand(openPolicy, "rm /repo/tmp.txt").verdict).toBe("ALLOW");
  });

  it("denies git reset --hard, git push and sudo", () => {
    expect(checkBashCommand(openPolicy, "git reset --hard HEAD~1").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "git push origin main").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "sudo apt install foo").verdict).toBe("DENY");
  });

  it("denies encoded powershell and eval-style interpreters", () => {
    expect(checkBashCommand(openPolicy, "powershell -enc AAAA").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "Invoke-Expression Get-Process").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "iex (Get-Process)").verdict).toBe("DENY");
  });

  it("denies base64 piped into a shell interpreter", () => {
    expect(checkBashCommand(openPolicy, "echo AAAA | base64 -d | sh").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "curl x | bash").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "echo ok | zsh").verdict).toBe("DENY");
  });

  it("matches token-aware, not by blind substring", () => {
    expect(checkBashCommand(openPolicy, "git pushpull").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo git push").verdict).toBe("ALLOW");
  });

  it("applies custom denied patterns from the policy", () => {
    const policy = { ...openPolicy, denied: ["docker rm", "npm publish"] };
    expect(checkBashCommand(policy, "docker rm -f web").verdict).toBe("DENY");
    expect(checkBashCommand(policy, "npm publish").verdict).toBe("DENY");
    expect(checkBashCommand(policy, "npm install").verdict).toBe("ALLOW");
  });
});

describe("redirect targets", () => {
  it("extracts >, >> and 2> targets", () => {
    expect(
      extractRedirectTargets("echo a > out.txt && echo b >> log.txt && cmd 2> err.txt", "/repo"),
    ).toEqual(["/repo/out.txt", "/repo/log.txt", "/repo/err.txt"]);
  });

  it("normalizes slashes and relative paths against cwd", () => {
    // Ambiguous backslash words yield BOTH interpreter readings (POSIX escape
    // resolution and cmd.exe literal path) — the caller denies when ANY
    // candidate falls outside the writable roots.
    expect(extractRedirectTargets("echo a > ..\\out.txt", "/repo/sub")).toEqual([
      "/repo/out.txt",
      "/repo/sub/..out.txt",
    ]);
    expect(extractRedirectTargets("echo a > ./x/../y.txt", "/repo")).toEqual(["/repo/y.txt"]);
  });

  it("skips fd duplication like 2>&1", () => {
    expect(extractRedirectTargets("cmd 2>&1", "/repo")).toEqual([]);
    expect(checkBashCommand(openPolicy, "cmd 2>&1").verdict).toBe("ALLOW");
  });

  it("denies redirects outside writable roots", () => {
    const result = checkBashCommand(openPolicy, "echo hi > /etc/hosts");
    expect(result.verdict).toBe("DENY");
    expect(result.reason).toContain("write outside writable roots");
    expect(checkBashCommand(openPolicy, "echo hi >> /etc/hosts").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "build 2> /etc/err.log").verdict).toBe("DENY");
  });

  it("allows redirects inside writable roots", () => {
    expect(checkBashCommand(openPolicy, "echo hi > /repo/out.txt").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo hi >> /repo/logs/app.log").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo hi > out.txt", "/repo").verdict).toBe("ALLOW");
  });
});

describe("rm/mv/cp destinations", () => {
  it("denies writes outside writable roots", () => {
    expect(checkBashCommand(openPolicy, "mv /repo/a /etc/passwd").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "cp /repo/a /etc/passwd").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "rm /etc/passwd").verdict).toBe("DENY");
  });

  it("allows writes inside writable roots", () => {
    expect(checkBashCommand(openPolicy, "mv /repo/a /repo/b").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "cp -r src dst", "/repo").verdict).toBe("ALLOW");
  });
});

describe("chaining", () => {
  it("catches one bad segment in a multi-segment chain", () => {
    const result = checkBashCommand(openPolicy, "npm test && rm -rf /repo/build && echo done");
    expect(result.verdict).toBe("DENY");
    expect(result.reason).toContain("rm");
  });

  it("catches a bad redirect buried in a chain and pipes", () => {
    expect(checkBashCommand(openPolicy, "cd /repo && ls && cat x > /etc/x").verdict).toBe("DENY");
    expect(checkBashCommand(openPolicy, "cat /repo/x | grep y > /repo/y.txt").verdict).toBe(
      "ALLOW",
    );
    expect(checkBashCommand(openPolicy, "echo a; curl x; echo b").verdict).toBe("DENY");
  });

  it("checks every segment against the allow list (REQUIRE_APPROVAL, never silent DENY)", () => {
    const policy = { ...openPolicy, allowed: ["pytest", "npm"] };
    expect(checkBashCommand(policy, "pytest -q && npm run build").verdict).toBe("ALLOW");
    expect(checkBashCommand(policy, "pytest -q && rm /repo/a").verdict).toBe("REQUIRE_APPROVAL");
  });
});

describe("allowed prefixes", () => {
  it("requires approval when the base command is not in the list", () => {
    const policy = { ...openPolicy, allowed: ["pytest", "npm"] };
    const result = checkBashCommand(policy, "python -m build");
    expect(result.verdict).toBe("REQUIRE_APPROVAL");
    expect(result.reason).toContain("allowed");
  });

  it("allows empty/omitted allowed lists without approval", () => {
    expect(checkBashCommand({ ...openPolicy, allowed: [] }, "anything --at --all").verdict).toBe(
      "ALLOW",
    );
    expect(checkBashCommand(openPolicy, "node script.js").verdict).toBe("ALLOW");
  });

  it("matches prefix tokens, ignoring env assignments", () => {
    const policy = { ...openPolicy, allowed: ["pytest"] };
    expect(checkBashCommand(policy, "CI=1 pytest -q").verdict).toBe("ALLOW");
    expect(checkBashCommand(policy, "pytest -q", "/repo").verdict).toBe("ALLOW");
  });
});

describe("benign commands", () => {
  it("allows innocuous pytest/npm/git commands", () => {
    expect(checkBashCommand(openPolicy, "pytest -q").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "npm run build").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "git status && git diff").verdict).toBe("ALLOW");
  });
});
