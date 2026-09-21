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
  // Inline PowerShell: same code-execution bypass as `-enc`, different flag.
  { tokens: ["powershell", "-c"], reason: "inline PowerShell ('-c') is denied" },
  { tokens: ["powershell", "-command"], reason: "inline PowerShell ('-Command') is denied" },
  { tokens: ["pwsh", "-c"], reason: "inline PowerShell ('-c') is denied" },
  { tokens: ["pwsh", "-command"], reason: "inline PowerShell ('-Command') is denied" },
  // Destructive Windows shell forms the POSIX deny list cannot see.
  { tokens: ["cmd", "/c", "rmdir"], reason: "destructive 'cmd /c rmdir' is denied" },
  { tokens: ["cmd", "/c", "rd"], reason: "destructive 'cmd /c rd' is denied" },
  { tokens: ["cmd", "/c", "del"], reason: "destructive 'cmd /c del' is denied" },
  { tokens: ["cmd", "/c", "erase"], reason: "destructive 'cmd /c erase' is denied" },
  { tokens: ["rmdir", "/s"], reason: "destructive 'rmdir /s' is denied" },
  { tokens: ["rd", "/s"], reason: "destructive 'rd /s' is denied" },
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

/** Strip one pair of surrounding quotes and resolve the escapes the shell
 * resolves inside them: double quotes keep the backslash escapes (`\"`,
 * `\\`), single quotes are fully literal, and a backslash outside quotes
 * escapes the next character. What comes out is what the shell would pass
 * to exec — `git pu\sh`, `"git" "push"` and `$'git push'` all normalize to
 * `git push`. */
function shellResolve(token: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  // `$'…'` (ANSI-C) and `$"…"` are quoting forms: the `$` prefix is shell
  // syntax, not part of the exec'd word.
  if (token.length >= 2 && token[0] === "$" && (token[1] === "'" || token[1] === '"')) {
    i = 1;
  }
  for (; i < token.length; i++) {
    const ch = token[i] ?? "";
    if (quote !== null) {
      if (quote === '"' && ch === "\\") {
        const next = token[i + 1] ?? "";
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          out += next;
          i++;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      const next = token[i + 1] ?? "";
      out += next;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
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

/** Base command of a token list: skips leading `VAR=...` assignments, resolves
 * shell escapes, and de-qualifies absolute/relative binary paths so
 * `/bin/git push` and `./git push` match the `git` deny patterns (probe C3).
 * On Windows `cwd`-relative bare commands are handled by the runtime env
 * guard (NoDefaultCurrentDirectoryInExePath), not here. */
function commandBase(tokens: string[]): string {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    const word = shellResolve(token);
    const base = word.includes("/")
      ? (word.split("/").pop() ?? word)
      : word.includes("\\")
        ? (word.split("\\").pop() ?? word)
        : word;
    return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
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

/**
 * Words that pass the wrapped command through unchanged: POSIX utilities and
 * shell builtins whose first non-flag argument is another command line.
 * `sudo` is already denied outright; these wrappers otherwise made
 * `command git push` / `env git push` / `exec git push` invisible to the
 * deny list (probe C3).
 */
const COMMAND_WRAPPERS = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "timeout",
  "time",
  "watch",
]);

/**
 * Canonical exec view of a token list: unwrap pass-through wrappers and git
 * global flags so the deny list matches what actually executes.
 * - `command git push`, `env git push`, `exec git push`, `nice -n 5 git
 *   push`, `timeout 5 git push` → base becomes `git`;
 * - `git -c k=v push`, `git --work-tree=/tmp push` → second word becomes
 *   `push` (global flags consume the following value).
 */
function canonicalTokens(tokens: string[]): string[] {
  let out = [...tokens];
  // Unwrap pass-through wrappers.
  for (;;) {
    const base = commandBase(out);
    if (!COMMAND_WRAPPERS.has(base)) break;
    const start = out.findIndex((t) => shellResolve(unquote(t)).toLowerCase() === base);
    if (start === -1) break;
    let i = start + 1;
    // Skip wrapper options and their values (e.g. `nice -n 5`, `env -i
    // VAR=1`, `command -p`); `timeout` takes a POSITIONAL duration
    // (`timeout 5 git push`) which must also be skipped (probe C3).
    if (base === "timeout" && /^\d+$/.test(shellResolve(unquote(out[i] ?? "")))) {
      i += 1;
    }
    while (i < out.length) {
      const word = shellResolve(unquote(out[i] ?? "")).toLowerCase();
      if (word.startsWith("-")) {
        i += 1;
        if (
          word === "-n" ||
          word === "-i" ||
          word === "-u" ||
          word === "-p" ||
          base === "timeout"
        ) {
          i += 1;
        }
        continue;
      }
      if (word.includes("=")) {
        i += 1;
        continue;
      }
      break;
    }
    out = out.slice(i);
  }
  // Strip git global flags. Only VALUE-TAKING globals consume the next
  // token — value-less ones (--no-pager, --bare, …) must not eat the
  // subcommand (probe C3: `git --no-pager push` became just `git`).
  if (commandBase(out) === "git") {
    const start = out.findIndex((t) => shellResolve(unquote(t)).toLowerCase() === "git");
    if (start !== -1) {
      const GIT_VALUE_FLAGS = new Set([
        "-c",
        "--exec-path",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--super-prefix",
        "--config-env",
      ]);
      let i = start + 1;
      while (i < out.length && (out[i] ?? "").startsWith("-")) {
        const flag = shellResolve(unquote(out[i] ?? "")).toLowerCase();
        // `--flag=value` carries its value inline (1 token); a bare value-
        // taking flag consumes the NEXT token (2 tokens).
        const consumesNext = GIT_VALUE_FLAGS.has(flag.split("=")[0] ?? flag) && !flag.includes("=");
        i += consumesNext ? 2 : 1;
      }
      out = [...out.slice(0, start + 1), ...out.slice(i)];
    }
  }
  return out;
}

/** Deny reason for one segment, or `null` when the segment passes.
 * DOUBLE-INTERPRETER AWARENESS: on Windows exec() runs commands through
 * cmd.exe, where a backslash is a path separator, not an escape. Each token
 * is therefore resolved BOTH ways — POSIX (backslash escapes) and cmd
 * (backslash literal) — and the deny list matches on whichever reading it
 * finds, negating if either interpretation is denied. */
function denyReasonForSegment(segmentTokens: string[], customDenied: string[]): string | null {
  if (segmentTokens.length === 0) {
    return null;
  }
  const posix = segmentTokens.map((token) => shellResolve(token).toLowerCase());
  const cmdRaw = segmentTokens.map((token) => token.toLowerCase());
  // De-qualified view: the head binary with an absolute/relative path
  // (`/bin/git push`, `./git push`, `C:\bin\git.exe push`) reduced to its
  // base name — a deny list must match the binary that runs, not the spelling.
  const dequalify = (tokens: string[]): string[] => {
    const out = [...tokens];
    for (let i = 0; i < out.length; i++) {
      const token = out[i] ?? "";
      if (/^[a-z_][a-z0-9_]*=/.test(token)) continue;
      if (token.includes("/") || token.includes("\\")) {
        const base = commandBase([token]);
        if (base.length > 0) out[i] = base;
      }
      break;
    }
    return out;
  };
  const cmdRawDeq = dequalify(cmdRaw);
  const posixDeq = dequalify(posix);
  for (const lowered of [posix, cmdRaw, posixDeq, cmdRawDeq]) {
    // Canonical exec view: wrappers unwrapped, git global flags stripped —
    // the deny list matches what actually runs, not how it was spelled.
    const canonical = canonicalTokens(lowered);
    for (const view of [canonical, lowered]) {
      for (const entry of customDenied) {
        const pattern = patternTokens(entry);
        if (pattern.length > 0 && matchesPattern(view, pattern)) {
          return `denied command pattern: '${entry.trim()}'`;
        }
      }
      for (const builtin of BUILTIN_DENY_PATTERNS) {
        if (matchesPattern(view, builtin.tokens)) {
          return builtin.reason;
        }
      }
      const rmReason = recursiveRmReason(view);
      if (rmReason !== null) {
        return rmReason;
      }
      if (segmentTokens.length === 1 && SHELL_INTERPRETERS.has(view[0] ?? "")) {
        return "piping into a shell interpreter is denied";
      }
    }
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
    // Both readings for ambiguous backslash words (see extractRedirectTargets).
    const resolved = shellResolve(unquote(token));
    const word = unquote(token);
    args.push(...(resolved === word ? [word] : [word, resolved]));
  }
  return args;
}

/**
 * Extract every output-redirect target (`>`, `>>`, `2>`, ...) from a command,
 * plus the cmd.exe READING of ambiguous backslash paths (`..\x` on cmd is a
 * parent-dir path, on POSIX an escaped filename): BOTH candidates are
 * returned so the caller can deny when any interpretation falls outside the
 * writable roots. File-descriptor duplications (`2>&1`) are skipped.
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
      const rawWord = unquote(tokens[i + 1] ?? "");
      i++;
      if (rawWord.length === 0 || rawWord.startsWith("&")) {
        continue;
      }
      const resolved = shellResolve(rawWord);
      const candidates = resolved === rawWord ? [rawWord] : [rawWord, resolved];
      for (const candidate of candidates) {
        const normalized = normalizePath(candidate, cwd);
        if (!targets.includes(normalized)) {
          targets.push(normalized);
        }
      }
    }
  }
  return targets;
}

/**
 * Embedded shell code visible inside a segment: `$(...)` bodies, backtick
 * spans, and the inline-code argument of `eval` / `bash -c` / `python -c` /
 * `node -e` / similar. Each extracted command is re-checked through the full
 * policy recursively, so `echo $(git push)` is caught as the `git push` it
 * really executes.
 */
function extractEmbeddedCommands(segment: string): string[] {
  const found: string[] = [];
  // $( ... ) with paren balance; unterminated → the rest is embedded.
  let idx = segment.indexOf("$(");
  while (idx !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = idx + 1; i < segment.length; i++) {
      const ch = segment[i] ?? "";
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      found.push(segment.slice(idx + 2));
      break;
    }
    found.push(segment.slice(idx + 2, end));
    idx = segment.indexOf("$(", end);
  }
  // ` ... ` spans.
  const bt = segment.split("`");
  for (let i = 1; i < bt.length; i += 2) {
    found.push(bt[i] ?? "");
  }
  // Process substitution bodies: `<(…)` and `>(…)` are full command lines.
  const ps = segment.match(/[<>]\(([\s\S]*?)\)/g) ?? [];
  for (const m of ps) {
    found.push(m.slice(2, -1));
  }
  // Inline-code arguments of interpreters. `cmd /c …` re-parses its whole
  // tail as a command line, so everything after the flag is embedded.
  const tokens = tokenizeSegment(segment);
  const base = commandBase(tokens);
  const codeFlags = new Set(["-c", "-e", "-p"]);
  if (base === "eval" || base === "source" || base === ".") {
    found.push(
      tokens
        .slice(1)
        .map((t) => shellResolve(unquote(t)))
        .join(" "),
    );
  } else if (base === "cmd") {
    const tail = tokens.slice(1).filter((t) => shellResolve(unquote(t)).toLowerCase() !== "/c");
    found.push(tail.map((t) => shellResolve(unquote(t))).join(" "));
  } else {
    for (let i = 1; i < tokens.length; i++) {
      const flag = shellResolve(unquote(tokens[i] ?? ""));
      const bare = flag.replace(/^--?/, "");
      if (
        codeFlags.has(flag) ||
        (flag.startsWith("--") && (bare === "command" || bare === "eval"))
      ) {
        const next = tokens[i + 1];
        if (next !== undefined) found.push(shellResolve(unquote(next)));
      }
    }
  }
  return found.filter((s) => s.trim().length > 0);
}

/**
 * Deny-or-approval reason for shell indirection the static token view cannot
 * fully see through: command substitution and inline-interpreter invocation.
 * The embedded command (when statically visible) is checked separately via
 * {@link extractEmbeddedCommands}; the FORM itself is always at least an
 * approval — the REPL asks the operator, the swarm refuses approvals.
 */
function indirectionFormReason(segment: string): string | null {
  if (/\$\(/.test(segment)) {
    return "command substitution '$(...)' requires approval (embedded code is re-checked statically)";
  }
  if (segment.includes("`")) {
    return "command substitution backticks require approval (embedded code is re-checked statically)";
  }
  // Parameter/expansion forms the tokenizer cannot see through ($IFS word
  // splitting, ${…} substitution, brace expansion). Only refuse them when
  // they sit on a deny-relevant head word — benign usages keep working.
  const headTokens = tokenizeSegment(segment);
  const rawBase = (() => {
    for (const token of headTokens) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      return token.toLowerCase();
    }
    return "";
  })();
  const denyRelevant =
    /\b(git|rm|mv|cp|tee|bash|sh|zsh|dash|eval|source|powershell|pwsh|cmd|curl|wget|nc|ssh|ftp|telnet|python|python3|node|perl|ruby|php|sudo|command|env|exec)\b/.test(
      rawBase.replace(/\$\{?/g, " "),
    ) ||
    /^(git|rm|mv|cp|tee|bash|sh|zsh|dash|eval|source|powershell|pwsh|cmd|curl|wget|nc|ssh|ftp|telnet|python|python3|node|perl|ruby|php|sudo|command|env|exec)(\$\{?[A-Za-z0-9_]*\?)?/.test(
      rawBase,
    );
  if (denyRelevant && /\$\{?[A-Za-z_]/.test(segment)) {
    return "variable expansion on a restricted command requires approval (e.g. ${IFS} word-splitting)";
  }
  if (denyRelevant && /\{.*,.*\}/.test(segment)) {
    return "brace expansion on a restricted command requires approval";
  }
  // Process substitution `<(…)` / `>(…)`: the inside is a full command line.
  // The embedded command is extracted by extractEmbeddedCommands and
  // re-checked by the caller; here only the opaque FORM is flagged.
  if (/[<>]\(/.test(segment)) {
    return "process substitution requires approval (embedded command is re-checked statically)";
  }
  const tokens = tokenizeSegment(segment).map((token) => shellResolve(token).toLowerCase());
  const base = commandBase(tokens);
  if (base === "eval" || base === "source" || base === ".") {
    return `'${base}' re-interprets its argument as shell code and requires approval`;
  }
  if (base === "bash" || base === "sh" || base === "zsh" || base === "dash") {
    const flags = tokens.slice(1).filter((t) => t.startsWith("-") && t.length > 1);
    if (flags.some((f) => f.includes("c") || f.includes("i") || f.includes("s"))) {
      return `${base} with inline code (-c/-i/-s) requires approval`;
    }
  }
  if (base === "cmd" && tokens.some((t) => t === "/c" || t === "/k")) {
    return "cmd /c re-parses its tail as a command line and requires approval";
  }
  if (
    (base === "python" ||
      base === "python3" ||
      base === "node" ||
      base === "perl" ||
      base === "ruby" ||
      base === "php") &&
    tokens.some((t) => t === "-e" || t === "-c" || t === "-p")
  ) {
    return `${base} inline code (-c/-e/-p) requires approval`;
  }
  return null;
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

  // (2b) Substitution / indirection forms: every statically visible embedded
  // command is re-checked through the full policy (a nested `git push` is
  // DENY, not an approval), and the form itself always requires approval —
  // the REPL asks the operator, the swarm refuses approvals by contract.
  for (const segment of segments) {
    for (const inner of extractEmbeddedCommands(segment)) {
      const nested = checkBashCommand(policy, inner, cwd);
      if (nested.verdict === "DENY") {
        return {
          verdict: "DENY",
          reason: `embedded command denied: ${nested.reason ?? inner.trim()}`,
        };
      }
    }
    const form = indirectionFormReason(segment);
    if (form !== null) {
      return { verdict: "REQUIRE_APPROVAL", reason: form };
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

  // (4) rm/mv/cp/tee writing outside the writable roots. `tee` writes to
  // every file operand (its stdin argument is not a path).
  for (const segment of segments) {
    const tokens = tokenizeSegment(segment);
    const base = commandBase(tokens);
    if (base !== "rm" && base !== "mv" && base !== "cp" && base !== "tee") {
      continue;
    }
    const args = pathArgs(tokens);
    if (args.length === 0) {
      continue;
    }
    const writeTargets = (
      base === "rm" || base === "tee" ? args : [args[args.length - 1] ?? ""]
    ).map((target) => normalizePath(target, cwd));
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
