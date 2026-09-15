/**
 * packages/cli/src/swarm-view.ts — live multi-pane view for `/swarm`.
 *
 * Layout (TTY): one live area redrawn in place —
 *
 *   ╭─ ELYSIUM SWARM ─ <goal>
 *     MASTER
 *     [ok] task-1  crea il file alpha.txt · 8s      ← ALL tasks listed
 *     >>  task-2  crea beta.txt · 12s
 *     ··  task-4  task in coda
 *     -- critic task-1: passed                      ← event trail
 *   ╭─ >> task-2 · crea beta.txt con contatore · 12s
 *   │ streaming output line…
 *   │ second line…
 *   ╰─ tools 3 · write · attempts 2
 *   ╭─ >> task-3 · verifica i contenuti · 7s
 *   │ …
 *   ╰─ tools 1
 *   ╭─ >> task-5 · quarto pane visibile · 3s
 *   │ …
 *   ╰─ tools 0
 *     panes 3/3 · + altri 4 subagent in parallelo · Ctrl+C/Esc cancella
 *
 * The agent may run ANY number of subagents; the UI shows AT MOST
 * {@link MAX_PANES} live panes (running → queued → finished priority) plus
 * the MASTER column listing every task, and the footer counts the ones
 * running beyond the visible panes.
 *
 * Non-TTY (piped/tests): nothing is redrawn — events degrade to compact
 * linear lines, so piped output stays deterministic.
 */
import { cyan, dim, green, lime, magenta, neon, red, stripAnsi, yellow, marks } from "./ui";

/** Maximum simultaneous subagent panes (the "max 3 visible" rule). */
export const MAX_PANES = 3;

export type TaskStatus = "queued" | "running" | "repair" | "pass" | "fail" | "partial";

const STATUS_GLYPH: Record<TaskStatus, string> = {
  queued: dim("··"),
  running: magenta(">>"),
  repair: yellow("[!!]"),
  pass: green(marks.ok),
  fail: red(marks.err),
  partial: yellow("[..]"),
};

/** Status glyph for a task status (exported for tests). */
export function statusGlyph(status: TaskStatus): string {
  return STATUS_GLYPH[status] ?? dim("··");
}

/** Truncate a plain string to `w` visible chars, ellipsis-marked. */
export function truncate(s: string, w: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= w) return t;
  return `${t.slice(0, Math.max(1, w - 1)).trimEnd()}…`;
}

/**
 * Pane assignment: running tasks first, then QUEUED (so upcoming work is
 * already visible), then the freshest finished ones fill the remaining
 * slots. Never exceeds MAX_PANES. Exported for tests.
 */
export function assignPanes(order: string[], status: Map<string, TaskStatus>): string[] {
  const isLive = (id: string): boolean => {
    const s = status.get(id);
    return s === "running" || s === "repair";
  };
  const running = order.filter(isLive);
  const queued = order.filter((id) => status.get(id) === "queued");
  const finished = order.filter((id) => !isLive(id) && status.get(id) !== "queued");
  return [...running, ...queued, ...finished].slice(0, MAX_PANES);
}

interface TaskPane {
  goal: string;
  status: TaskStatus;
  tools: number;
  lastTool: string;
  outLines: string[];
  startedAt: number | null;
  endedAt: number | null;
  attempts: number;
}

const OUT_ROWS = 2;

export interface SwarmView {
  /** Print the plan block and (TTY) start the live area. */
  plan(goal: string, tasks: Array<{ id: string; goal: string }>, workspace: string): void;
  taskStarted(id: string): void;
  taskOutput(id: string, text: string): void;
  taskTool(id: string, tool: string, isError: boolean): void;
  taskEnded(id: string, status: string, durationMs: number, attempts: number): void;
  critic(id: string, passed: boolean): void;
  repair(id: string, round: number): void;
  error(message: string): void;
  /** Plain-data snapshot of the current swarm state (no ANSI). */
  snapshot(): SwarmSnapshot;
  /** Stop the live loop; returns control of the output to the caller. */
  finish(): void;
}

/** One task row of a {@link SwarmSnapshot}: plain data, no ANSI codes. */
export interface SwarmSnapshotTask {
  id: string;
  status: TaskStatus;
  tools: number;
  attempts: number;
  /** Seconds since start; 0 if not started; frozen at end once ended. */
  elapsedSec: number;
  lastTool: string;
}

/** Plain-data view of the swarm state, safe for programmatic consumption. */
export interface SwarmSnapshot {
  goal: string;
  running: number;
  total: number;
  tasks: SwarmSnapshotTask[];
}

/** Creates a swarm live view bound to the current stdout. */
export function createSwarmView(): SwarmView {
  const animated = process.stdout.isTTY === true;
  const tasks = new Map<string, TaskPane>();
  const order: string[] = [];
  let goalText = "";
  let workspacePath = "";
  const trail: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let frameRows = 0;

  const pushTrail = (line: string): void => {
    trail.push(line);
    if (trail.length > 3) trail.shift();
  };

  const setTaskStatus = (id: string, status: TaskStatus): void => {
    const t = tasks.get(id);
    if (t) t.status = status;
  };

  // ── Non-TTY linear printer ──
  const linear = (line: string): void => {
    console.log(line);
  };

  const elapsedOf = (t: TaskPane): string =>
    t.startedAt === null
      ? ""
      : ` · ${Math.max(0, Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000))}s`;

  const statusMap = (): Map<string, TaskStatus> =>
    new Map([...tasks.entries()].map(([k, v]) => [k, v.status]));

  const clip = (s: string, width: number): string => {
    const visible = stripAnsi(s).length;
    return visible <= width ? s : dim(truncate(stripAnsi(s), width - 1));
  };

  const renderFrame = (): void => {
    if (!animated) return;
    const width = Math.max(80, process.stdout.columns ?? 100);
    const inner = width - 6;
    const rows: string[] = [];

    // ── Header ──
    rows.push(clip(`╭─ ${neon("ELYSIUM SWARM")}  ${dim(truncate(goalText, inner - 18))}`, inner));

    // ── MASTER: every task, full list ──
    rows.push(`  ${lime("MASTER")}`);
    for (const id of order) {
      const t = tasks.get(id);
      if (!t) continue;
      rows.push(
        clip(
          `  ${statusGlyph(t.status)} ${dim(id.padEnd(8))}${truncate(t.goal, inner - 18)}${dim(elapsedOf(t))}`,
          inner,
        ),
      );
    }
    for (const line of trail) rows.push(clip(`  ${dim(`-- ${line}`)}`, inner));

    // ── Panes: stacked full-width boxes, max MAX_PANES ──
    const paneIds = assignPanes(order, statusMap());
    for (const id of paneIds) {
      const t = tasks.get(id);
      if (!t) continue;
      rows.push(
        clip(
          `╭─ ${statusGlyph(t.status)} ${dim(id)} · ${truncate(t.goal, inner - 14)}${dim(elapsedOf(t))}`,
          inner,
        ),
      );
      for (let i = 0; i < OUT_ROWS; i += 1) {
        const raw = t.outLines[i] ?? "";
        const line = raw.length > 0 ? dim(truncate(raw, inner - 3)) : dim("…");
        rows.push(clip(`│ ${line}`, inner));
      }
      const meta = `╰─ tools ${t.tools}${t.lastTool.length > 0 ? ` · ${t.lastTool}` : ""}${t.attempts > 1 ? ` · attempts ${t.attempts}` : ""}`;
      rows.push(clip(meta, inner));
    }

    // ── Footer: panes + subagents beyond the visible cap ──
    const runningCount = [...tasks.values()].filter(
      (t) => t.status === "running" || t.status === "repair",
    ).length;
    const hidden = Math.max(0, order.length - MAX_PANES);
    const parts = [
      `panes ${paneIds.length}/${MAX_PANES}`,
      hidden > 0 ? `+ altri ${hidden} subagent in parallelo` : "",
      "Ctrl+C/Esc cancella",
    ].filter((p) => p.length > 0);
    rows.push(`  ${dim(parts.join(" · "))}`);

    // Repaint: jump to frame origin, clear+rewrite every row (also the ones
    // left over if the frame shrank). No raw ANSI-unaware slicing anywhere.
    let out = frameRows > 0 ? `\u001B[${frameRows}A\r` : "";
    const total = Math.max(rows.length, frameRows);
    for (let i = 0; i < total; i += 1) out += `\u001B[K${rows[i] ?? ""}\n`;
    process.stdout.write(out);
    frameRows = rows.length;
  };

  const startLoop = (): void => {
    if (!animated || timer !== null) return;
    timer = setInterval(renderFrame, 150);
    timer.unref();
  };

  const noteOut = (id: string, text: string): void => {
    const t = tasks.get(id);
    if (!t) return;
    for (const raw of text.split("\n")) {
      const line = stripAnsi(raw).replace(/\s+/g, " ").trim();
      if (line.length === 0) continue;
      // Store plain text; the renderer clips to the width (visible).
      t.outLines.push(truncate(line, 160));
      while (t.outLines.length > OUT_ROWS) t.outLines.shift();
    }
  };

  return {
    plan(goal, list, workspace): void {
      goalText = goal;
      workspacePath = workspace;
      console.log(`\n  ${cyan("plan")}`);
      for (const t of list) {
        tasks.set(t.id, {
          goal: t.goal,
          status: "queued",
          tools: 0,
          lastTool: "",
          outLines: [],
          startedAt: null,
          endedAt: null,
          attempts: 1,
        });
        order.push(t.id);
        console.log(`    ${dim(t.id)}  ${t.goal}`);
      }
      if (list.length > MAX_PANES) {
        console.log(
          `  ${dim(`vista live: ${MAX_PANES} pane + master — ${list.length - MAX_PANES} subagent seguiranno in parallelo`)}`,
        );
      }
      console.log(`  ${dim(`workspace: ${workspacePath}`)}`);
      if (!animated) {
        linear(`  ${dim("events:")}`);
        return;
      }
      console.log();
      startLoop();
    },
    taskStarted(id): void {
      const t = tasks.get(id);
      if (t) {
        t.status = "running";
        t.startedAt = Date.now();
        t.endedAt = null;
      }
      pushTrail(`${id} started`);
      if (!animated) linear(`  ${magenta(">>")} start ${id}`);
    },
    taskOutput(id, text): void {
      noteOut(id, text);
    },
    taskTool(id, tool, isError): void {
      const t = tasks.get(id);
      if (t) {
        t.tools += 1;
        t.lastTool = `${tool}${isError ? " [!!]" : ""}`;
      }
      if (!animated) linear(`  ${dim(`tool ${id} ${tool}${isError ? " [!!]" : ""}`)}`);
    },
    taskEnded(id, status, durationMs, attempts): void {
      const t = tasks.get(id);
      const s: TaskStatus =
        status === "pass"
          ? "pass"
          : status === "fail"
            ? "fail"
            : status === "partial"
              ? "partial"
              : "fail";
      if (t) {
        t.status = s;
        t.endedAt = Date.now();
        t.attempts = attempts;
        if (t.startedAt !== null) t.startedAt = t.endedAt - durationMs;
      }
      pushTrail(
        `${id} ${status} (${(durationMs / 1000).toFixed(1)}s, ${attempts} attempt${attempts > 1 ? "s" : ""})`,
      );
      if (!animated) linear(`  ${statusGlyph(s)} ${id} ${status}`);
    },
    critic(id, passed): void {
      pushTrail(`critic ${id}: ${passed ? "passed" : "repair scheduled"}`);
      if (!animated) {
        linear(
          `  ${passed ? green(marks.ok) : yellow(marks.warn)} critic ${id} ${passed ? "passed" : "repair scheduled"}`,
        );
      }
    },
    repair(id, round): void {
      setTaskStatus(id, "repair");
      pushTrail(`repair ${id} (round ${round})`);
      if (!animated) linear(`  ${yellow(marks.warn)} repair ${id}`);
    },
    error(message): void {
      pushTrail(`error: ${message}`);
      if (!animated) linear(`  ${red(marks.err)} ${message}`);
    },
    finish(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Leave the last frame on screen; the caller prints the report after.
      frameRows = 0;
    },
    snapshot(): SwarmSnapshot {
      const rows: SwarmSnapshotTask[] = order.map((id) => {
        const t = tasks.get(id);
        if (t === undefined) {
          return { id, status: "queued", tools: 0, attempts: 1, elapsedSec: 0, lastTool: "" };
        }
        const elapsed =
          t.startedAt === null ? 0 : Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000);
        return {
          id,
          status: t.status,
          tools: t.tools,
          attempts: t.attempts,
          elapsedSec: Math.max(0, elapsed),
          lastTool: t.lastTool,
        };
      });
      return {
        goal: goalText,
        running: rows.filter((r) => r.status === "running" || r.status === "repair").length,
        total: rows.length,
        tasks: rows,
      };
    },
  };
}
