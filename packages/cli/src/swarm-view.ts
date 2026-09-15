/**
 * packages/cli/src/swarm-view.ts — live multi-pane view for `/swarm`.
 *
 * Layout (TTY): one full-screen live area redrawn in place —
 *   ┌ MASTER (plan, critic/repair trail) ─┬──── up to 3 SUBAGENT panes ────┐
 *   │ goal + per-task status glyphs       │ task-1: streamed output lines  │
 *   │ event trail (critic, repair, …)     │ task-2: tools + last output    │
 *   └─────────────────────────────────────┴──── task-3 ────────────────────┘
 *
 * Hard cap: at most 3 simultaneous subagent panes. Panes are assigned to
 * RUNNING tasks first; finished panes are recycled for queued tasks, so a
 * plan with N>3 subtasks still shows a live window of 3 (the rest appear as
 * queued rows in the MASTER column).
 *
 * Non-TTY (piped/tests): nothing is redrawn — events degrade to compact
 * linear lines, so piped output stays deterministic.
 */
import { cyan, dim, green, magenta, marks, red, stripAnsi, yellow } from "./ui";

/** Maximum simultaneous subagent panes (the "max 3 CLI" rule). */
export const MAX_PANES = 3;

export type TaskStatus = "queued" | "running" | "repair" | "pass" | "fail" | "partial";

const STATUS_GLYPH: Record<TaskStatus, string> = {
  queued: dim("·"),
  running: magenta(">>"),
  repair: yellow("[!!]"),
  pass: green(marks.ok),
  fail: red(marks.err),
  partial: yellow("[..]"),
};

/** Status glyph for a task status (exported for tests). */
export function statusGlyph(status: TaskStatus): string {
  return STATUS_GLYPH[status] ?? dim("·");
}

/** Truncate a plain string to `w` visible chars, ellipsis-marked. */
export function truncate(s: string, w: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= w) return t;
  return `${t.slice(0, Math.max(1, w - 1)).trimEnd()}…`;
}

/**
 * Pane assignment: running tasks first, then QUEUED (so upcoming work is
 * already visible and transitions are smooth), then the freshest finished
 * ones fill the remaining slots. Never exceeds MAX_PANES. Exported for tests.
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

const OUT_ROWS = 5;

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
  /** Stop the live loop; returns control of the output to the caller. */
  finish(): void;
}

/** Creates a swarm live view bound to the current stdout. */
export function createSwarmView(): SwarmView {
  const animated = process.stdout.isTTY === true;
  const tasks = new Map<string, TaskPane>();
  const order: string[] = [];
  let goalText = "";
  const trail: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let frameRows = 0;

  const pushTrail = (line: string): void => {
    trail.push(line);
    if (trail.length > 6) trail.shift();
  };

  const paneFor = (id: string): TaskPane | undefined => tasks.get(id);

  const setTaskStatus = (id: string, status: TaskStatus): void => {
    const t = tasks.get(id);
    if (t) t.status = status;
  };

  // ── Non-TTY linear printer ──
  const linear = (line: string): void => {
    console.log(line);
  };

  const renderFrame = (): void => {
    if (!animated) return;
    const width = Math.max(80, process.stdout.columns ?? 100);
    const rows: string[] = [];
    const masterW = 38;
    const paneIdsAll = assignPanes(
      order,
      new Map([...tasks.entries()].map(([k, v]) => [k, v.status])),
    );
    // Adaptive pane count: each pane needs ~26 visible columns; never 0.
    const maxFit = Math.max(1, Math.floor((width - masterW - 8) / 26));
    const paneIds = paneIdsAll.slice(0, Math.max(1, maxFit));
    const paneCount = Math.max(1, paneIds.length);
    const paneW = Math.max(24, Math.floor((width - masterW - 8) / paneCount) - 2);

    rows.push(`  ${bold0("ELYSIUM SWARM")}  ${dim(truncate(goalText, width - 24))}`);
    rows.push(dim("─".repeat(width - 2)));

    // Content rows: master column lines interleaved with pane lines.
    const bodyRows = 1 + OUT_ROWS + 1;
    const masterLines = renderMasterLines(masterW, bodyRows);
    for (let r = 0; r < bodyRows; r += 1) {
      const left = masterLines[r] ?? "";
      if (r === 0) {
        const cells = paneIds.map((id) => paneTitle(id, paneW));
        rows.push(`${left}${dim("│ ")}${cells.join(dim("│ "))}`);
      } else if (r <= OUT_ROWS) {
        const row = r - 1;
        const cells = paneIds.map((id) => paneOutLine(id, row, paneW));
        rows.push(`${left}${dim("│ ")}${cells.join(dim("│ "))}`);
      } else {
        const cells = paneIds.map((id) => paneMetaLine(id, paneW));
        rows.push(`${left}${dim("│ ")}${cells.join(dim("│ "))}`);
      }
    }
    rows.push(dim("─".repeat(width - 2)));
    const runningCount = [...tasks.values()].filter(
      (t) => t.status === "running" || t.status === "repair",
    ).length;
    const queuedCount = [...tasks.values()].filter((t) => t.status === "queued").length;
    rows.push(
      `  ${dim(`running ${runningCount}/${order.length}${queuedCount > 0 ? ` · queued ${queuedCount}` : ""} · panes ${paneIds.length}/${MAX_PANES} · Ctrl+C/Esc cancels`)}`,
    );

    // Move cursor up to the frame origin and rewrite every row. Rows are
    // built within the visible width (cells pre-clipped), so no raw slicing:
    // a naive slice(0, width) would count invisible ANSI bytes and cut cells.
    const clear = rows.map((l) => `\u001B[K${l}`).join("\n");
    process.stdout.write(`${frameRows > 0 ? `\u001B[${frameRows}A\r` : ""}${clear}\n`);
    frameRows = rows.length;
  };

  const renderMasterLines = (w: number, count: number): string[] => {
    const out: string[] = [];
    out.push(`  ${cyan("MASTER")}`);
    for (const id of order) {
      const t = tasks.get(id);
      if (!t) continue;
      const elapsed =
        t.startedAt !== null
          ? ` ${Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000)}s`
          : "";
      out.push(
        `  ${statusGlyph(t.status)} ${truncate(id, 8)} ${truncate(t.goal, w - 16)}${dim(elapsed)}`,
      );
    }
    for (const line of trail) out.push(`  ${dim(truncate(line, w - 2))}`);
    while (out.length < count) out.push("");
    return out.slice(0, count).map((l) => padVisual(l, w + 2));
  };

  const paneTitle = (id: string, w: number): string => {
    const t = tasks.get(id);
    if (!t) return padVisual("", w);
    const elapsed =
      t.startedAt !== null
        ? ` ${Math.floor(((t.endedAt ?? Date.now()) - t.startedAt) / 1000)}s`
        : "";
    return padVisual(
      ` ${statusGlyph(t.status)} ${truncate(id, 8)} ${truncate(t.goal, Math.max(6, w - 16))}${dim(elapsed)} `,
      w,
    );
  };

  const paneOutLine = (id: string, row: number, w: number): string => {
    const t = tasks.get(id);
    const raw = t?.outLines[row] ?? "";
    const line = raw.length > 0 ? dim(truncate(raw, Math.max(4, w - 4))) : "";
    return padVisual(` ${line} `, w);
  };

  const paneMetaLine = (id: string, w: number): string => {
    const t = tasks.get(id);
    if (!t) return padVisual("", w);
    const last = t.lastTool.length > 0 ? ` · ${t.lastTool}` : "";
    return padVisual(
      ` ${dim(`tools ${t.tools}${t.attempts > 1 ? ` · attempts ${t.attempts}` : ""}${last}`)} `,
      w,
    );
  };

  const padVisual = (s: string, w: number): string => {
    const visible = stripAnsi(s).length;
    return visible >= w ? `${s}${" "}` : `${s}${" ".repeat(w - visible)}`;
  };

  const bold0 = (s: string): string => `\u001B[1m${s}\u001B[22m`;

  const startLoop = (): void => {
    if (!animated || timer !== null) return;
    timer = setInterval(renderFrame, 150);
    timer.unref();
  };

  const noteOut = (id: string, text: string): void => {
    const t = paneFor(id);
    if (!t) return;
    for (const raw of text.split("\n")) {
      const line = stripAnsi(raw).replace(/\s+/g, " ").trim();
      if (line.length === 0) continue;
      // Store plain text; the renderer clips to the pane width (visible).
      t.outLines.push(truncate(line, 120));
      while (t.outLines.length > OUT_ROWS) t.outLines.shift();
    }
  };

  return {
    plan(goal, list, workspace): void {
      goalText = goal;
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
      const overflow = list.length - MAX_PANES;
      if (overflow > 0) {
        console.log(
          `  ${dim(`live view: ${MAX_PANES} panes (cap), ${overflow} queued will recycle into panes`)}`,
        );
      }
      console.log(`  ${dim(`workspace: ${workspace}`)}`);
      if (!animated) {
        linear(`  ${dim("events:")}`);
        return;
      }
      console.log();
      startLoop();
    },
    taskStarted(id): void {
      const t = paneFor(id);
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
      const t = paneFor(id);
      if (t) {
        t.tools += 1;
        t.lastTool = `${tool}${isError ? " [!!]" : ""}`;
      }
      if (!animated) linear(`  ${dim(`tool ${id} ${tool}${isError ? " [!!]" : ""}`)}`);
    },
    taskEnded(id, status, durationMs, attempts): void {
      const t = paneFor(id);
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
        if (t.startedAt !== null && t.endedAt !== null) {
          // Keep the pane showing final output; freeze elapsed at end.
          t.startedAt = t.endedAt - durationMs;
        }
      }
      pushTrail(
        `${id} ${status} (${(durationMs / 1000).toFixed(1)}s, ${attempts} attempt${attempts > 1 ? "s" : ""})`,
      );
      if (!animated) linear(`  ${statusGlyph(s)} ${id} ${status}`);
    },
    critic(id, passed): void {
      pushTrail(`critic ${id}: ${passed ? "passed" : "repair scheduled"}`);
      if (!animated)
        linear(
          `  ${passed ? green(marks.ok) : yellow(marks.warn)} critic ${id} ${passed ? "passed" : "repair scheduled"}`,
        );
    },
    repair(id, round): void {
      const t = paneFor(id);
      if (t) t.status = "repair";
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
      // Leave the last frame on screen; caller prints the report after.
      frameRows = 0;
    },
  };
}
