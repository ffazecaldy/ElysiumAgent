/**
 * Task ownership enforcement — per-task path policies for swarm builders.
 *
 * A {@link TaskPathPolicy} declares which path globs a subtask may write,
 * which it may only read, and which it must never touch at all. The swarm
 * spawn path consults it via {@link checkPath} before executing write/edit
 * (mode "write") and read (mode "read") tools; bash is deliberately out of
 * scope (documented gap).
 *
 * Matching semantics: default-deny for writes (only `allowed` globs grant
 * write access), default-allow for reads (only `forbidden` globs block).
 */

/** Glob-style path policy for one swarm task. */
export interface TaskPathPolicy {
  /** Globs the task may create/modify. Writes outside these are denied. */
  allowed: string[];
  /** Globs the task may read but not write. */
  readOnly: string[];
  /** Globs the task must never touch (checked first, wins over allowed). */
  forbidden: string[];
}

/**
 * Fallback regex for invalid globs: matches nothing, ever. `[^\s\S]` cannot
 * succeed for any character, so even an empty input is rejected.
 */
const NEVER_MATCH: RegExp = /[^\s\S]/;

/** Normalizes a path for matching: forward slashes, no leading `./`, collapsed duplicates. */
export function normalizePath(path: string): string {
  let out = path.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  // Collapse `.` and `a/..` segments the way the filesystem would resolve
  // them: a glob match must see the real path, not the raw spelling
  // (`src/../escape.ts` is `escape.ts` — matching it against `src/**` would
  // let a write escape its ownership root).
  const stack: string[] = [];
  for (const part of out.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Leading `..` stays (it points outside any root and no allowed glob
      // anchored at the root can match it — fail closed).
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else stack.push("..");
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

/** True when the glob contains only the supported syntax: `**`, `*`, `?`, literal chars. */
export function isValidGlob(glob: string): boolean {
  const normalized = glob.trim();
  if (normalized.length === 0) return false;
  // Unterminated bracket blocks are not supported syntax here.
  if (/\[(?:[^\]]*\[|[^\]]*$)/.test(normalized)) return false;
  return !/[^\w\-. /*?\[\]]/.test(normalized);
}

/**
 * Compiles a glob into a RegExp. Supported syntax: `**` matches across path
 * separators (any depth), `*` within one segment, `?` exactly one character.
 * An invalid glob (empty, control/unsafe characters, broken syntax) fails
 * closed: the returned regex never matches anything.
 */
export function parseGlobToRegex(glob: string): RegExp {
  if (typeof glob !== "string") return NEVER_MATCH;
  const normalized = glob.trim();
  if (!isValidGlob(normalized)) return NEVER_MATCH;

  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch: string = normalized[i] ?? "";
    if (ch === "") break;
    if (ch === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        out += "(?:.|\\n)*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^(?:${out})$`);
}

/**
 * Decides whether `path` may be accessed in `mode` under `policy`.
 *
 * - mode "write": forbidden → deny; allowed → grant; otherwise deny
 *   (default-deny — writes only happen inside `allowed` globs).
 * - mode "read": forbidden → deny; otherwise grant (readOnly, allowed and
 *   unlisted paths are all readable).
 *
 * Matching is normalized: backslashes become `/`, a leading `./` is dropped,
 * and the path is anchored so `src/auth/**` matches `src/auth/login.ts` and
 * `src/auth/depth/leaf.ts` alike.
 */
export function checkPath(
  policy: TaskPathPolicy,
  path: string,
  mode: "write" | "read" = "write",
): { allowed: boolean; mode: "write" | "read" } {
  const normalized = normalizePath(path);
  const denied =
    policy.forbidden.some((glob) => parseGlobToRegex(glob).test(normalized)) ||
    (mode === "write" && !policy.allowed.some((glob) => parseGlobToRegex(glob).test(normalized)));
  return { allowed: !denied, mode };
}
