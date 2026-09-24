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

  it("still allows file-shaped interpreter usage (except script files — F-06)", () => {
    // F-06: workspace script files are approval-form (content invisible to
    // static analysis — `bash build.sh` may do anything).
    expect(checkBashCommand(openPolicy, "bash build.sh").verdict).toBe("REQUIRE_APPROVAL");
    // F-06: `node script.js` executes a workspace-staged file the gate cannot
    // inspect — now APPROVE (the live SEC03 bypass class).
    expect(checkBashCommand(openPolicy, "node script.js").verdict).toBe("REQUIRE_APPROVAL");
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

describe("probe campaign 2 regressions: wrappers, git globals, expansion", () => {
  it("denies deny-listed commands behind pass-through wrappers", () => {
    for (const cmd of [
      "command git push",
      "env git push",
      "exec git push",
      "nice git push",
      "timeout 5 git push",
      "nohup git push",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("strips git global flags (value and value-less) before matching", () => {
    for (const cmd of ["git -c x=y push", "git --work-tree=/tmp push", "git --no-pager push"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("denies deny-listed commands via absolute/relative binary paths", () => {
    for (const cmd of [
      "/bin/git push",
      "./git push",
      "/usr/bin/rm -rf /repo",
      "C:/bin/git.exe push",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
  });

  it("requires approval for variable/brace expansion on restricted heads", () => {
    for (const cmd of ["git${IFS}push", "git$IFS push", "git push {origin,mirror}"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
    // Benign expansion elsewhere stays allowed.
    expect(checkBashCommand(openPolicy, "echo ${HOME}").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "echo a{b,c}").verdict).toBe("ALLOW");
  });

  it("blocks process substitution and re-checks the embedded command", () => {
    const denied = checkBashCommand(openPolicy, "diff <(git push) /dev/null");
    expect(denied.verdict).toBe("DENY");
    expect(denied.reason).toContain("embedded command denied");
    const benign = checkBashCommand(openPolicy, "diff <(sort a.txt) b.txt");
    expect(benign.verdict).toBe("REQUIRE_APPROVAL");
  });

  it("still allows benign wrappers and value-less git flags", () => {
    expect(checkBashCommand(openPolicy, "command git status").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "env CI=1 npm test").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "git --no-pager status").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "timeout 30 npm test").verdict).toBe("ALLOW");
  });
});

describe("F-06 regression — bypass classes closed (semantic, not string)", () => {
  it("input→command transformation: find -exec embedding a denied command", () => {
    for (const cmd of [
      "find . -depth -type d -name src -exec rm -rf {} +",
      "find . -name '*.tmp' -exec rm -rf {} +",
      "find . -execdir rm -rf {} +",
    ]) {
      const r = checkBashCommand(openPolicy, cmd);
      expect(["DENY", "REQUIRE_APPROVAL"]).toContain(r.verdict);
    }
  });

  it("benign find without destructive exec stays allowed", () => {
    expect(checkBashCommand(openPolicy, "find . -name '*.ts'").verdict).toBe("ALLOW");
    // Non-destructive embedded commands pass the find-exec re-check.
    expect(checkBashCommand(openPolicy, "find . -name x -exec grep y {} +").verdict).toBe("ALLOW");
  });

  it("workspace script execution via interpreter is approval-form", () => {
    for (const cmd of ["bash s.sh", "sh run.sh", "zsh deploy.sh"]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
    // Path-qualified scripts were never the gap (content equally invisible,
    // but they resolve outside the writable root assumption) — they stay
    // consistent with the historical ALLOW for file-shaped invocations.
    expect(checkBashCommand(openPolicy, "bash build.sh").verdict).toBe("REQUIRE_APPROVAL");
  });

  it("shell loop feeding rm is approval-form (runtime-sourced paths)", () => {
    const r = checkBashCommand(openPolicy, "while read f; do rm -rf $f; done < list.txt");
    expect(r.verdict).toBe("REQUIRE_APPROVAL");
    expect(r.reason).toContain("loop feeding 'rm'");
  });

  it("destructive flag on non-rm binaries: tar --remove-files in any position", () => {
    for (const cmd of [
      "tar czf /dev/null --remove-files src",
      "tar --remove-files -czf /dev/null src",
      "tar czf out.tar --remove-files src",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("DENY");
    }
    // Benign tar stays allowed.
    expect(checkBashCommand(openPolicy, "tar czf out.tar src").verdict).toBe("ALLOW");
  });

  it("busybox multiplexer is denied (applet dispatch is opaque)", () => {
    expect(checkBashCommand(openPolicy, "busybox rm -rf src").verdict).toBe("DENY");
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
