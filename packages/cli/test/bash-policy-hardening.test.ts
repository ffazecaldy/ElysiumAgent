/** Regression tests for the probe campaign holes (B1/B2/B3/B4/B5/B13). */
import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../src/policy/bash-policy";

const openPolicy = {
  denied: ["rm -rf", "git reset --hard", "git push", "sudo", "powershell -enc"],
  writableRoots: ["/repo"],
  networkAllowed: true,
};
const swarmPolicy = { ...openPolicy, networkAllowed: false };

describe("probe regressions: quoted/escaped deny bypass (B1)", () => {
  it("resolves quoted tokens to their exec form before matching", () => {
    for (const cmd of ['"git" "push"', "git 'push'", '"git" push', 'git "push" --force']) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("resolves backslash escapes outside quotes (exec-form matching)", () => {
    // Outside quotes a backslash escapes the next char; inside DOUBLE quotes
    // bash keeps `\u` literally (the arg really is `p\ush`, a distinct word),
    // so only the outside-quote form must match `git push`.
    for (const cmd of ["git pu\\sh", "gi\\t push"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
    // Documented shell semantics: '"git" "p\ush"' execs `git` with arg `p\ush`
    // (not `push`) — no deny match, ALLOW is correct, not a bypass.
    expect(checkBashCommand(openPolicy, '"git" "p\\ush"').verdict).toBe("ALLOW");
  });

  it("resolves ANSI-C quoting per-word ($'git' 'push'), not on the whole token", () => {
    // `$'git push'` as ONE word execs a command literally named `git push`
    // (command-not-found) — no deny match, ALLOW is correct. The real bypass
    // is per-word ANSI-C quoting, which must DENY.
    expect(checkBashCommand(openPolicy, "$'git push'").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, '$"git push"').verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "$'git' 'push'").verdict).toBe("DENY");
  });

  it("still treats `echo git push` as an opaque argument (no overblocking)", () => {
    expect(checkBashCommand(openPolicy, "echo git push").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo 'git push'").verdict).toBe("ALLOW");
  });
});

describe("probe regressions: substitution and inline interpreters (B2/B3)", () => {
  it("denies a denied command embedded in $( ) substitution", () => {
    const r = checkBashCommand(openPolicy, "echo $(git push)");
    expect(r.verdict).toBe("DENY");
    expect(r.reason).toContain("embedded command denied");
  });

  it("denies a denied command embedded in backticks", () => {
    const r = checkBashCommand(openPolicy, "echo `git push`");
    expect(r.verdict).toBe("DENY");
    expect(r.reason).toContain("embedded command denied");
  });

  it("requires approval for the substitution form even with a benign payload", () => {
    for (const cmd of ["echo $(date)", "echo `whoami`"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  it("requires approval for eval / source inline re-interpretation", () => {
    for (const cmd of ['eval "git status"', "source script.sh", ". ./env.sh"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  it("requires approval for shell interpreters with inline code flags", () => {
    for (const cmd of ['bash -c "git status"', "sh -c date", "zsh -i", "dash -s"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  it("requires approval for python/node inline code (network-capable)", () => {
    for (const cmd of ["python -c 'import os'", "node -e fetch", "python3 -c x"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  it("marks a network-capable inline payload as blocked (approval refused in swarm)", () => {
    // Inline code is not statically decidable; the form is REQUIRE_APPROVAL,
    // which the swarm refuses (documented no-approver contract) and the REPL
    // puts to the operator — either way it never runs unattended.
    const r = checkBashCommand(swarmPolicy, "node -e require('http').get('http://x')");
    expect(["DENY", "REQUIRE_APPROVAL"]).toContain(r.verdict);
  });

  it("still allows file-shaped interpreter usage", () => {
    expect(checkBashCommand(openPolicy, "bash build.sh").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "node script.js").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "python -m pytest").verdict).toBe("ALLOW");
  });
});

describe("probe regressions: destructive shell forms (B4)", () => {
  it("denies inline PowerShell and pwsh", () => {
    for (const cmd of [
      "powershell -c Remove-Item",
      "powershell -Command Remove-Item",
      "pwsh -c Get-Process",
      "pwsh -command iex",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("denies bare destructive Windows forms and inline PowerShell", () => {
    for (const cmd of [
      "rmdir /s build",
      "rd /s build",
      "powershell -c Remove-Item",
      "powershell -Command Remove-Item",
      "pwsh -c Get-Process",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("blocks cmd /c tails: denied payload → DENY, benign payload → approval (never silent)", () => {
    const denied = checkBashCommand(openPolicy, 'cmd /c "rmdir /s /q build"');
    expect(denied.verdict).toBe("DENY");
    expect(denied.reason).toContain("embedded command denied");
    const benign = checkBashCommand(openPolicy, "cmd /c echo ok");
    expect(benign.verdict).toBe("REQUIRE_APPROVAL");
    expect(benign.reason).toContain("approval");
  });
});

describe("probe regressions: tee as a write primitive (B5)", () => {
  it("denies tee writing outside the writable roots", () => {
    const r = checkBashCommand(openPolicy, "echo x | tee /etc/hosts");
    expect(r.verdict).toBe("DENY");
    expect(r.reason).toContain("write outside writable roots");
  });

  it("allows tee inside the writable roots", () => {
    expect(checkBashCommand(openPolicy, "echo x | tee /repo/out.txt").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo x | tee -a /repo/log.txt").verdict).toBe("ALLOW");
  });
});
