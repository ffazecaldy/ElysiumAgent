/**
 * Pure Bash command policy: token-aware static analysis of shell commands.
 *
 * Nothing in this module executes anything — every function is a pure
 * string-to-verdict computation. Matching is token-aware, never a blind
 * substring search: commands are split into chain segments (`&&`, `||`, `;`,
 * `|`, newline) and each segment into quote-aware tokens, so `curlx` does not
 * match `curl` and `echo "git push"` stays one opaque token.
 */

/** Policy input for {@link checkBashCommand}. */
export interface BashCommandPolicy {
  /**
   * Command prefixes the agent may run without approval. Omitted or empty
   * means "everything except `denied`".
   */
  allowed?: string[];
  /** Extra deny patterns (per prefix/command), applied on top of the built-ins. */
  denied: string[];
  /** Filesystem trees the command is allowed to write into. */
  writableRoots: string[];
  /** Whether network commands (curl/wget/nc/ssh/ftp/telnet) may run. */
  networkAllowed: boolean;
}

/** Possible outcomes of a policy check. */
export type BashVerdict = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

/** Result of a policy check: a verdict plus an optional human-readable reason. */
export interface BashCommandCheck {
  verdict: BashVerdict;
  reason?: string;
}

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ssh", "ftp", "telnet"]);

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash"]);

interface DenyPattern {
  tokens: string[];
  reason: string;
}

/**
 * Built-in deny patterns. Multi-token patterns match as a contiguous token
 * subsequence anywhere in a segment; single-token patterns must be the
 * segment's base command.
 */
const BUILTIN_DENY_PATTERNS: DenyPattern[] = [
  { tokens: ["git", "reset", "--hard"], reason: "destructive 'git reset --hard' is denied" },
  { tokens: ["git", "push"], reason: "'git push' is denied" },
  { tokens: ["powershell", "-enc"], reason: "encoded PowerShell ('-enc') is denied" },
  { tokens: ["powershell", "-encodedcommand"], reason: "encoded PowerShell is denied" },
  { tokens: ["pwsh", "-encodedcommand"], reason: "encoded PowerShell is denied" },
  { tokens: ["invoke-expression"], reason: "'invoke-expression' is denied" },
  { tokens: ["iex"], reason: "'iex' is denied" },
  { tokens: ["sudo"], reason: "'sudo' is denied" },
];

/** Split a command into chain segments on `&&`, `||`, `;`, `|` and newline. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.trim().length > 0) {
      segments.push(current);
    }
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        i++;
      }
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return segments;
}

/** Tokenize one segment: whitespace-separated, quote-aware, redirect ops standalone. */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      current += ch + (segment[i + 1] ?? "");
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === ">" || ch === "<") {
      let op = ch;
      if ((segment[i + 1] ?? "") === ">") {
        op += ">";
        i++;
      }
      let fd = "";
      if (/^\d+$/.test(current)) {
        fd = current;
        current = "";
      }
      flush();
      tokens.push(fd + op);
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** Strip one pair of surrounding quotes from a token. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** True for output redirect operator tokens: `>`, `>>`, `2>`, `2>>`, `&>`, `&>>`. */
function isOutputRedirectOp(token: string): boolean {
  return /^(\d*>>|&>>|\d*>|&>)$/.test(token);
}

/**
 * Normalize a path: forward slashes, `.`/`..` collapsed, relative paths
 * resolved against `cwd` when provided. `~` is left untouched.
 */
function normalizePath(p: string, cwd?: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (s.length === 0) {
    return s;
  }
  let drive = "";
  const driveMatch = /^([a-zA-Z]:)(?=\/|$)/.exec(s);
  if (driveMatch?.[1]) {
    drive = driveMatch[1];
    s = s.slice(drive.length);
  }
  let absolute = s.startsWith("/");
  if (!absolute && cwd !== undefined && cwd.trim().length > 0) {
    const base = normalizePath(cwd);
    const baseDrive = /^([a-zA-Z]:)(?=\/|$)/.exec(base);
    if (baseDrive?.[1]) {
      drive = baseDrive[1];
      absolute = true;
      s = `${base.slice(baseDrive[1].length).replace(/\/+$/, "")}/${s}`;
    } else if (base.startsWith("/")) {
      absolute = true;
      s = `${base.replace(/\/+$/, "")}/${s}`;
    } else {
      s = `${base.replace(/\/+$/, "")}/${s}`;
    }
  }
  const stack: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      const last = stack[stack.length - 1];
      if (stack.length > 0 && last !== "..") {
        stack.pop();
      } else if (!absolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  if (drive.length > 0) {
    return `${drive}/${joined}`;
  }
  return absolute ? `/${joined}` : joined;
}

/** Whether `target` equals or lives under one of `roots` (case-insensitive). */
function isWithinAnyRoot(roots: string[], target: string): boolean {
  const normalizedTarget = normalizePath(target).toLowerCase();
  if (normalizedTarget.length === 0) {
    return false;
  }
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root).toLowerCase().replace(/\/+$/, "");
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  });
}

/** Base command of a token list: skips leading `VAR=...` assignments, unquotes. */
function commandBase(tokens: string[]): string {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return unquote(token).toLowerCase();
  }
  return "";
}

/** Token-aware pattern match anchored at the command head (after leading
 * `VAR=...` assignments): the pattern must match token-for-token from there,
 * so `echo git push` is NOT a `git push`. Single-token patterns therefore
 * match the base command only. */
function matchesPattern(loweredTokens: string[], pattern: string[]): boolean {
  if (pattern.length === 0) {
    return false;
  }
  let start = 0;
  while (start < loweredTokens.length && /^[a-z_][a-z0-9_]*=/.test(loweredTokens[start] ?? "")) {
    start++;
  }
  if (start + pattern.length > loweredTokens.length) {
    return false;
  }
  for (let j = 0; j < pattern.length; j++) {
    if (loweredTokens[start + j] !== pattern[j]) {
      return false;
    }
  }
  return true;
}

function patternTokens(entry: string): string[] {
  return entry
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

/** `rm` with any recursive flag (`-r`, `-rf`, `-fr`, `-R`, `--recursive`, ...). */
function recursiveRmReason(tokens: string[]): string | null {
  if (commandBase(tokens) !== "rm") {
    return null;
  }
  let recursive = false;
  for (const token of tokens.slice(1)) {
    if (token === "--") {
      break;
    }
    if (token === "--recursive") {
      recursive = true;
    } else if (token.startsWith("-") && !token.startsWith("--")) {
      for (const flagChar of token.slice(1)) {
        if (flagChar === "r" || flagChar === "R") {
          recursive = true;
        }
      }
    }
  }
  return recursive ? "destructive recursive 'rm' is denied" : null;
}

/** Deny reason for one segment, or `null` when the segment passes. */
function denyReasonForSegment(segmentTokens: string[], customDenied: string[]): string | null {
  if (segmentTokens.length === 0) {
    return null;
  }
  const lowered = segmentTokens.map((token) => token.toLowerCase());
  for (const entry of customDenied) {
    const pattern = patternTokens(entry);
    if (pattern.length > 0 && matchesPattern(lowered, pattern)) {
      return `denied command pattern: '${entry.trim()}'`;
    }
  }
  for (const builtin of BUILTIN_DENY_PATTERNS) {
    if (matchesPattern(lowered, builtin.tokens)) {
      return builtin.reason;
    }
  }
  const rmReason = recursiveRmReason(lowered);
  if (rmReason !== null) {
    return rmReason;
  }
  if (segmentTokens.length === 1 && SHELL_INTERPRETERS.has(lowered[0] ?? "")) {
    return "piping into a shell interpreter is denied";
  }
  return null;
}

/** Path-like operands of a segment: skips flags, redirects and env assignments. */
function pathArgs(segmentTokens: string[]): string[] {
  const args: string[] = [];
  let start = 0;
  while (
    start < segmentTokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(segmentTokens[start] ?? "")
  ) {
    start++;
  }
  start++;
  let skipNext = false;
  for (let i = start; i < segmentTokens.length; i++) {
    const token = segmentTokens[i] ?? "";
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (isOutputRedirectOp(token) || token === "<") {
      skipNext = true;
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      continue;
    }
    args.push(unquote(token));
  }
  return args;
}

/**
 * Extract every output-redirect target (`>`, `>>`, `2>`, ...) from a command,
 * slash-normalized and resolved against `cwd` when relative. File-descriptor
 * duplications (`2>&1`) are not paths and are skipped.
 */
export function extractRedirectTargets(command: string, cwd?: string): string[] {
  const targets: string[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenizeSegment(segment);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (!isOutputRedirectOp(token)) {
        continue;
      }
      const raw = unquote(tokens[i + 1] ?? "");
      i++;
      if (raw.length === 0 || raw.startsWith("&")) {
        continue;
      }
      targets.push(normalizePath(raw, cwd));
    }
  }
  return targets;
}

/**
 * Check a command string against a {@link BashCommandPolicy} without ever
 * executing it. Every chain segment is checked; the first DENY wins, then
 * REQUIRE_APPROVAL, otherwise ALLOW.
 */
export function checkBashCommand(
  policy: BashCommandPolicy,
  command: string,
  cwd?: string,
): BashCommandCheck {
  const segments = splitSegments(command)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { verdict: "ALLOW" };
  }

  // (1) Network commands.
  if (!policy.networkAllowed) {
    for (const segment of segments) {
      const base = commandBase(tokenizeSegment(segment));
      if (NETWORK_COMMANDS.has(base)) {
        return { verdict: "DENY", reason: `network command not allowed: ${base}` };
      }
    }
  }

  // (2) Deny list (built-ins plus policy.denied), token-aware.
  for (const segment of segments) {
    const reason = denyReasonForSegment(tokenizeSegment(segment), policy.denied);
    if (reason !== null) {
      return { verdict: "DENY", reason };
    }
  }

  // (3) Redirect targets outside the writable roots.
  for (const target of extractRedirectTargets(command, cwd)) {
    if (!isWithinAnyRoot(policy.writableRoots, target)) {
      return { verdict: "DENY", reason: `write outside writable roots: ${target}` };
    }
  }

  // (4) rm/mv/cp writing outside the writable roots.
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    const base = commandBase(tokens);
    if (base !== "rm" && base !== "mv" && base !== "cp") {
      continue;
    }
    const args = pathArgs(tokens);
    if (args.length === 0) {
      continue;
    }
    const writeTargets = (base === "rm" ? args : [args[args.length - 1] ?? ""]).map((target) =>
      normalizePath(target, cwd),
    );
    for (const target of writeTargets) {
      if (!isWithinAnyRoot(policy.writableRoots, target)) {
        return { verdict: "DENY", reason: `write outside writable roots: ${target}` };
      }
    }
  }

  // (5) Allow-list prefixes: `allowed` omitted/empty means unrestricted.
  if (policy.allowed !== undefined && policy.allowed.length > 0) {
    for (const segment of segments) {
      const lowered = tokenizeSegment(segment).map((token) => token.toLowerCase());
      const permitted = policy.allowed.some((prefix) => {
        const pattern = patternTokens(prefix);
        if (pattern.length === 0) {
          return false;
        }
        // Skip leading `VAR=...` env assignments before prefix matching.
        let start = 0;
        while (start < lowered.length && /^[a-z_][a-z0-9_]*=/.test(lowered[start] ?? "")) {
          start++;
        }
        if (start + pattern.length > lowered.length) {
          return false;
        }
        return pattern.every((part, index) => lowered[start + index] === part);
      });
      if (!permitted) {
        return {
          verdict: "REQUIRE_APPROVAL",
          reason: `command not in allowed prefixes: ${commandBase(lowered)}`,
        };
      }
    }
  }

  // (6) Fallback.
  return { verdict: "ALLOW" };
}
