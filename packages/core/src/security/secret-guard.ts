/**
 * SecretGuard — systematic redaction boundary for the harness.
 *
 * Pure module (zero node dependencies): regex detection of common secret
 * formats plus exact-value redaction for loaded env values, applied
 * recursively to strings nested in objects/arrays before they cross a
 * boundary (logs, events, proof packages, tool output).
 *
 * Complements the CLI's `maskSecret` (display truncation): SecretGuard is the
 * systematic replacement applied to whole texts/objects.
 */

/** A builtin detection rule: a stable name and the regex matching that secret form. */
export interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * Builtin secret patterns.
 *
 * All patterns carry the `g` flag; `redactText` re-instantiates them per call
 * (`lastIndex` of a shared module-level regex would otherwise leak state
 * across calls). The `***REDACTED:...***` marker form is deliberately shaped
 * so a second `redactText` pass leaves it untouched (idempotency): the
 * assigned-secret pattern refuses values that already start with `***`.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    // PEM private key blocks (RSA / EC / DSA / OPENSSH / ENCRYPTED, PKCS-8),
    // any line endings — matched first so the whole key body is redacted
    // as one unit instead of leaking the base64 body.
    name: "pem_private_key",
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // OpenAI keys: project keys (`sk-proj-...`) and legacy keys (`sk-...`).
    name: "openai_api_key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    // GitHub tokens: classic PAT (ghp_), OAuth (gho_), server (ghs_), user
    // (ghu_), refresh (ghr_), and fine-grained PATs (github_pat_).
    name: "github_token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{3,}\b|\bgithub_pat_[A-Za-z0-9_]{11,}\b/g,
  },
  {
    // AWS access key ids: AKIA (long-term), ASIA (temporary), ABIA/ACCA
    // (issued), followed by 16 uppercase alphanumeric chars.
    name: "aws_access_key_id",
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    // Slack tokens: bot (xoxb), user (xoxp), app-level (xoxa), refresh (xoxr),
    // legacy (xoxs).
    name: "slack_token",
    regex: /\bxox[aersbp]-[A-Za-z0-9-]{6,}\b/g,
  },
  {
    // JWT: three base64url segments (header.payload.signature), header
    // conventionally starting with `eyJ` (`{"` in base64).
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  },
  {
    // Bearer credentials in authorization headers / config lines.
    name: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{3,}/gi,
  },
  {
    // Generic secret assignments: password/secret/token/api_key (and common
    // variants, optionally prefixed like `MY_` / `DB_`) followed by =, : , =>
    // or ->, with bare, single- or double-quoted values (also JSON-ish
    // `"api_key": "..."`). Lookaheads refuse values that already start with
    // `***` so already-redacted text is left unchanged (idempotency).
    // Applied last; the value part is replaced by the marker while the key
    // and separator are preserved for log readability.
    name: "assigned_secret",
    regex:
      /\b([A-Za-z0-9]{1,32}_)?(api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key|password|passwd|pwd|secret|token)\b["']?\s*(?:=>|->|=|:)\s*(?:"(?!\*\*\*)[^"]*"|'(?!\*\*\*)[^']*'|(?!["'])(?!\*\*\*)[^\s"',;)]+)/gi,
  },
];

/** Replacement marker for a builtin pattern match. */
function markerFor(name: string): string {
  return `***REDACTED:${name}***`;
}

/**
 * Index of the first `=`/`:` separator (with optional `>`/`-` tail of `=>` /
 * `->`) inside an assigned_secret match — the prefix (key + separator) that
 * stays readable in the redacted output.
 */
function re_exec_prefix_sep(match: string): number | null {
  const m = /(?:=>|->|=|:)\s*/.exec(match);
  return m ? m.index + m[0].length : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact every secret occurrence in `text`.
 *
 * - Exact occurrences of any `extraValues` entry (loaded env values, trimmed
 *   length >= 8) become `***REDACTED:VALUE***`.
 * - Builtin pattern matches become `***REDACTED:<pattern-name>***`.
 *
 * Idempotent: `redactText(redactText(t)) === redactText(t)`.
 */
export function redactText(text: string, extraValues?: string[]): string {
  let result = text;

  // 1. Exact loaded values first, so a value that would also match a generic
  //    pattern gets the tighter VALUE label.
  if (extraValues && extraValues.length > 0) {
    const seen = new Set<string>();
    for (const raw of extraValues) {
      const value = raw.trim();
      if (value.length < 8 || seen.has(value)) continue;
      seen.add(value);
      result = result.replace(new RegExp(escapeRegExp(value), "g"), "***REDACTED:VALUE***");
    }
  }

  // 2. Structural patterns, in declaration order.
  for (const pattern of SECRET_PATTERNS) {
    // Fresh instance per call: a `g`-flagged regex reused across calls keeps
    // `lastIndex` state between matches.
    const re = new RegExp(pattern.regex.source, pattern.regex.flags);
    result = result.replace(re, (...args) => {
      // String.replace with `g`: [match, ...groups, offset, string].
      const match = args[0] as string;
      if (pattern.name === "assigned_secret") {
        // The key/separator prefix (groups 1-2) stays readable; only the
        // value part (everything after the first separator) is masked.
        const sep = re_exec_prefix_sep(match);
        if (sep !== null) {
          return `${match.slice(0, sep)}${markerFor(pattern.name)}`;
        }
      }
      return markerFor(pattern.name);
    });
  }

  return result;
}

/**
 * Deep-walk `obj`, redacting every string found in it (directly or nested in
 * arrays/objects). Returns a structural copy; the input is never mutated.
 * Non-string leaves (numbers, booleans, null, undefined, Dates, ...) are
 * carried over as-is.
 */
export function redactObject<T>(obj: T, extraValues?: string[]): T {
  if (typeof obj === "string") {
    return redactText(obj, extraValues) as unknown as T;
  }
  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    for (const item of obj) {
      out.push(redactObject(item, extraValues));
    }
    return out as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = redactObject(value, extraValues);
    }
    return out as unknown as T;
  }
  return obj;
}

/**
 * True when `text` contains builtin secret material or an exact occurrence of
 * any `extraValues` entry (trimmed length >= 8).
 */
export function containsSecret(text: string, extraValues?: string[]): boolean {
  return redactText(text, extraValues) !== text;
}
