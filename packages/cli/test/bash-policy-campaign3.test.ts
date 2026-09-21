/** Campaign 3 regressions: env poisoning, git honesty, cross-layer, fuzz seams. */
import { describe, expect, it } from "vitest";
import { checkBashCommand } from "../src/policy/bash-policy";

const openPolicy = {
  denied: ["rm -rf", "git reset --hard", "git push", "sudo", "powershell -enc"],
  writableRoots: ["/repo"],
  networkAllowed: true,
};

describe("campaign 3: environment poisoning (C5)", () => {
  it("requires approval for dangerous env assignments in any spelling", () => {
    for (const cmd of [
      "set PATH=C:/evil & git status",
      "export NODE_OPTIONS=--require ./evil.js && npm test",
      "export IFS=x && git status",
      "set PATHEXT=.cmd && git status",
      "NODE_OPTIONS=--require ./evil.js npm test",
      "env PATH=/evil git status",
      "HOME=/evil npm test",
      "PYTHONPATH=/evil python x.py",
    ]) {
      expect(checkBashCommand(openPolicy, cmd).verdict).toBe("REQUIRE_APPROVAL");
    }
  });

  it("still allows benign env assignments", () => {
    expect(checkBashCommand(openPolicy, "set FOO=bar && npm test").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "FOO=bar npm test").verdict).toBe("ALLOW");
    expect(checkBashCommand(openPolicy, "env CI=1 npm test").verdict).toBe("ALLOW");
  });

  it("requires approval for env with flags (-i wipes the environment)", () => {
    expect(checkBashCommand(openPolicy, "env -i git status").verdict).toBe("REQUIRE_APPROVAL");
  });
});

describe("campaign 3: seeded fuzz seams (C9)", () => {
  it("classifies every hostile random command without throwing", () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = [
      "git",
      "push",
      "rm",
      "-rf",
      "$(",
      ")",
      "`",
      "echo",
      "|",
      "&&",
      ";",
      ">",
      "'",
      '"',
      "\\",
      "..",
      "/",
      "*",
      "${IFS}",
      "\u202e",
      "\u0000",
      "\t",
      "ü",
      "--flags",
      "-c",
      "sudo",
      "powershell",
      "\\",
      "..\\",
      "%PATH%",
    ];
    for (let i = 0; i < 400; i++) {
      const parts: string[] = [];
      const n = 1 + Math.floor(rnd() * 6);
      for (let j = 0; j < n; j++) parts.push(alphabet[Math.floor(rnd() * alphabet.length)] ?? "");
      expect(() => checkBashCommand(openPolicy, parts.join(" "), "/repo")).not.toThrow();
    }
  });
});
