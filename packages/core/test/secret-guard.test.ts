/**
 * SecretGuard tests: builtin pattern detection, exact-value redaction,
 * deep object walking, containsSecret, false-positive resistance,
 * and idempotency of the redaction boundary.
 */
import { SECRET_PATTERNS, containsSecret, redactObject, redactText } from "@elysium/core";
import { describe, expect, it } from "vitest";

describe("SECRET_PATTERNS builtin coverage", () => {
  it("exposes the required builtin patterns", () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    for (const expected of [
      "openai_api_key",
      "github_token",
      "aws_access_key_id",
      "slack_token",
      "jwt",
      "bearer_token",
      "assigned_secret",
      "pem_private_key",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("redactText — builtin patterns", () => {
  it("redacts OpenAI keys (sk-...)", () => {
    expect(redactText("using key sk-abc123 today")).toBe(
      "using key ***REDACTED:openai_api_key*** today",
    );
    expect(redactText("using key sk-proj-abc123def456 today")).toBe(
      "using key ***REDACTED:openai_api_key*** today",
    );
  });

  it("redacts GitHub tokens (ghp_/gho_/github_pat_)", () => {
    expect(redactText(`ghp_${"x".repeat(30)}`)).toBe("***REDACTED:github_token***");
    expect(redactText(`gho_${"x".repeat(30)}`)).toBe("***REDACTED:github_token***");
    expect(redactText(`github_pat_${"x".repeat(20)}`)).toBe("***REDACTED:github_token***");
  });

  it("redacts AWS access key ids (AKIA...)", () => {
    expect(redactText(`AKIA${"2".repeat(16)}`)).toBe("***REDACTED:aws_access_key_id***");
  });

  it("redacts Slack tokens (xox...)", () => {
    expect(redactText(`xoxb-${"a".repeat(20)}`)).toBe("***REDACTED:slack_token***");
  });

  it("redacts JWTs (eyJ... three base64 segments)", () => {
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(redactText(`header ${jwt} trailer`)).toBe("header ***REDACTED:jwt*** trailer");
  });

  it("redacts PEM private key blocks, including the base64 body", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7alpha/beta/gamma/delta+chars",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactText(`header\n${pem}\nfooter`)).toBe(
      "header\n***REDACTED:pem_private_key***\nfooter",
    );
    const body = "A".repeat(64);
    const pem2 = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(redactText(`x ${pem2} y`)).toBe("x ***REDACTED:pem_private_key*** y");
  });

  it("redacts Bearer tokens", () => {
    expect(redactText("Bearer abc")).toBe("***REDACTED:bearer_token***");
    expect(redactText("Authorization: Bearer abc.def_ghi+jh==")).toBe(
      "Authorization: ***REDACTED:bearer_token***",
    );
  });

  it("redacts assigned secrets in several shapes, preserving the key", () => {
    expect(redactText("password=hunter2hunter2")).toBe("password=***REDACTED:assigned_secret***");
    expect(redactText("password: hunter2hunter2")).toBe("password: ***REDACTED:assigned_secret***");
    expect(redactText('api_key: "s3cr3t_v4lue"')).toBe("api_key: ***REDACTED:assigned_secret***");
    expect(redactText("export MY_TOKEN='abc123def456'")).toBe(
      "export MY_TOKEN=***REDACTED:assigned_secret***",
    );
    expect(redactText("client_secret -> zzz999yyy000")).toBe(
      "client_secret -> ***REDACTED:assigned_secret***",
    );
    expect(redactText('{"api_key": "abc123def456"}')).toBe(
      '{"api_key": ***REDACTED:assigned_secret***}',
    );
  });
});

describe("redactText — extraValues", () => {
  it("redacts exact loaded env values (len >= 8) as VALUE", () => {
    const out = redactText("connecting with hunter2hunter2 done", ["hunter2hunter2"]);
    expect(out).toBe("connecting with ***REDACTED:VALUE*** done");
  });

  it("ignores short values (< 8 chars) and misses no substring occurrence", () => {
    expect(redactText("pwd123", ["pwd123"])).toBe("pwd123");
    expect(redactText("a supersecretvalue b", ["supersecretvalue"])).toBe(
      "a ***REDACTED:VALUE*** b",
    );
  });

  it("combines extraValues with builtin patterns", () => {
    const out = redactText("sk-abc123 and hunter2hunter2!", ["hunter2hunter2"]);
    expect(out).toBe("***REDACTED:openai_api_key*** and ***REDACTED:VALUE***!");
  });
});

describe("redactObject", () => {
  it("deep-walks nested objects and arrays, returning a copy", () => {
    const input = { a: { b: [`sk-${"x".repeat(20)}`] } };
    const output = redactObject(input);
    expect(output).toEqual({ a: { b: ["***REDACTED:openai_api_key***"] } });
    expect(output).not.toBe(input);
    expect(input.a.b[0]).toBe(`sk-${"x".repeat(20)}`); // input untouched
  });

  it("passes extraValues through to every string leaf", () => {
    const input = {
      env: { KEY: "hunter2hunter2" },
      list: [{ note: "none" }, 5, null, true],
    };
    const output = redactObject(input, ["hunter2hunter2"]);
    expect(output).toEqual({
      env: { KEY: "***REDACTED:VALUE***" },
      list: [{ note: "none" }, 5, null, true],
    });
    expect(input.env.KEY).toBe("hunter2hunter2");
  });
});

describe("containsSecret", () => {
  it("returns true for builtin matches", () => {
    expect(containsSecret("token sk-abc123 here")).toBe(true);
    expect(containsSecret(`AKIA${"2".repeat(16)}`)).toBe(true);
  });

  it("returns true for exact extraValues matches", () => {
    expect(containsSecret("plain hunter2hunter2 text", ["hunter2hunter2"])).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecret("nothing to see here")).toBe(false);
    expect(containsSecret("")).toBe(false);
  });
});

describe("false-positive resistance", () => {
  it("leaves ordinary words untouched", () => {
    expect(redactText("I rode my skateboard to the tokenize workshop")).toBe(
      "I rode my skateboard to the tokenize workshop",
    );
    expect(redactText("TOKENIZE_TOKENIZE tokenise my_keyboard")).toBe(
      "TOKENIZE_TOKENIZE tokenise my_keyboard",
    );
    // A colon followed by a normal word is not an assignment of a secret key.
    expect(redactText("the password policy requires length")).toBe(
      "the password policy requires length",
    );
    // Generic short placeholder values are still masked when assigned.
    expect(redactText("token=abc123")).toBe("token=***REDACTED:assigned_secret***");
  });
});

describe("idempotency", () => {
  it("redacting twice yields the same result as once", () => {
    const samples = [
      `sk-${"x".repeat(20)}`,
      "Bearer abc",
      "password=hunter2hunter2",
      "value hunter2hunter2 end",
      `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`,
    ];
    for (const text of samples) {
      const once = redactText(text, ["hunter2hunter2"]);
      const twice = redactText(once, ["hunter2hunter2"]);
      expect(twice).toBe(once);
    }
  });

  it("idempotency holds for redactObject too", () => {
    const input = { a: { b: [`sk-${"x".repeat(20)}`], pw: "password=hunter2hunter2" } };
    const once = redactObject(input, ["hunter2hunter2"]);
    const twice = redactObject(once, ["hunter2hunter2"]);
    expect(twice).toEqual(once);
  });
});
