---
name: elysium-swarmloop
description: "The Multi-Agent Orchestration Engine with self-learning mechanisms, automatic solution-space exploration, and self-updating bootstrap. v0.15.0: Swarmloop Mode (gauntlet-style) with case-insensitive triggers MAX EFFORT / SWARMLOOP MODE / MESM, smart opt-in approval checkpoints, token-based cost gate (no fabricated prices), conditional PR/docs/RTK sections, e2e coverage for all v0.13+ phases."
version: 0.15.0
author: Boschi404 + ffazecaldy
testing-agent: Hermes Agent
tags: [agentic, auto, workflow, multi-agent, quality, research, iteration, scatter-gather, streaming-gather, self-learning, autonomous-loop, meta-scaling, orchestrator-depth2, self-improving, swarmloop, guardrails, security-shield, context-protection, contracts, clarification, plan-integration, sandbox-racing, quality-first, e2e-tested, project-docs, approval-checkpoints, swarmloop-mode, max-effort, mesm, cost-guardrail, case-insensitive-triggers]
user_preferences:
  language: "italiano"
  auto_commit: true
  auto_push: true
  test_command: "pytest -q"
  max_swarmloop_rounds: 3
  max_swarmloop_subagents: 50
---
# Elysium Swarmloop
The Multi-Agent Orchestration Engine with self-learning mechanisms
*Towards Agentic Utopia.*

> ⚠️ **Trasparenza:** il claim di self-learning resta "non verificato" — lo scoring engine ha un ceiling effect su correctness (dettagli in `risultati/AUDIT_SCORING_ENGINE.md`).

## Required Config (BEFORE FIRST USE)

These **Hermes config settings are mandatory**. Without them, the loop is castrated:

```yaml
delegation:
  max_concurrent_children: 100   # max parallelism (up to 100 subagents)
  max_async_children: 100        # same for async ops
  max_spawn_depth: 2             # orchestrators can spawn leaf workers
  child_timeout_seconds: 600     # generous timeout for complex tasks
  max_iterations: 50             # deep reasoning per agent
  orchestrator_enabled: true     # enable hierarchical orchestration
```

**Run these commands** (or edit `~/AppData/Local/hermes/config.yaml` directly):

```bash
hermes config set delegation.max_concurrent_children 100
hermes config set delegation.max_spawn_depth 2
hermes config set delegation.orchestrator_enabled true
hermes config set delegation.child_timeout_seconds 600
hermes config set approvals.mode smart
```

> **Why critical**: with defaults (3 subagents), Tier 4 tasks run at 3% of possible speed. The loop needs ALL 100 slots to reach full potential.

## User Preferences

The loop reads these settings from the YAML frontmatter at every execution:

| Setting | Default | Effect |
|---------|---------|--------|
| `language` | `italiano` | Response language for all communication |
| `auto_commit` | `true` | Git commit after every passing task |
| `auto_push` | `true` | Git push after every commit |
| `test_command` | `pytest -q` | Command used for test execution |
| `max_swarmloop_rounds` | `3` | Swarmloop Mode: hard cap on rounds (per-round user confirmation still required) |
| `max_swarmloop_subagents` | `50` | Swarmloop Mode: max subagents per round |

Override any preference by editing the `user_preferences:` section at the top of this file.
**Language note**: when the user writes in a non-English language, all responses, subagent contexts, commit messages and final reports are in that language. If `language` is set, it overrides auto-detection.

## Philosophy

**I don't follow a workflow. I am the loop. And I improve myself.**

> ⚠️ Il claim "I improve myself" si riferisce al meccanismo di Phase 4 (pattern capture, recall, calibration). La sua efficacia quantitativa non è ancora verificata con scorer affidabili — self-learning Δ non ri-benchmarkato con 6+ loop. Vedi nota di trasparenza all'inizio del documento.

Elysium Swarmloop is a self-improving autonomous orchestration engine that:
1. \*\*Decides what to do next\*\* — state machine, not recipe
2. \*\*Executes at any scale\*\* — 1 to 100 subagents per batch
3. \*\*Orchestrates hierarchically\*\* — depth-2: orchestrators spawn workers (depth-3 with B1-B6 rules for complex tasks)
4. \*\*Evaluates and retries instantly\*\* — streaming gather, no batching delay
5. \*\*Learns and evolves\*\* — captures patterns, calibrates, bumps version on improvement
6. \*\*Validates at every layer\*\* — security, file integrity, execution, context budget
7. \*\*Protects itself\*\* — 10 guardrails prevent self-learning contamination
\*\*Guardrails for self-modification:\*\*
- Every edit to this skill must \*\*improve the autonomous workflow\*\*, not add project-specific trivia
- No project error messages, framework-specific bugs, or dependency issues
- Each modification increments the PATCH version (v0.7.x), meaningful improvements bump MINOR (v0.x), breakthrough rewrites bump MAJOR (v1.0.0)
- When version bumps, release notes go in the GitHub Release — NO in-skill changelog (context is budget)
---
### ⚖️ Precedence Rule — Policy Conflict Resolution
When two sections describe alternative policies for the same moment in the flow, \*\*the most restrictive wins\*\* (safety > autonomy). Order of precedence:
1. ⚖️ \*\*Precedence Rule\*\* (this section) — always active
2. 💸 \*\*Pre-Flight Cost Check (Phase 0.7a)\*\* — hard gate, no swarmloop dispatch without user confirmation
3. 🛡️ \*\*Guardrails (Phase 4e)\*\* — protect the system from itself
4. 🪜 \*\*Escalation Ladder (Phase 3j)\*\* — user decides on below-threshold gaps
5. 🧠 \*\*Context Protection (Phase 3d)\*\* — prevents overflow/saturation
6. 🎯 \*\*4-Band Filter\*\* — pre-check before loading skill
7. ✨ \*\*Quality Gate (Phase 3)\*\* — evaluates and retries
8. 📡 \*\*Scatter (Phase 2)\*\* — parallel dispatch
\*\*Example:\*\* if Quality Gate says "accept task below threshold" but Escalation Ladder says "escalate to user" → Escalation wins. If Phase 2 says "dispatch 50 streaming" but Context Protection says "max 20-25 in-flight" → Context Protection wins.
---
### 🎯 4-Band Filter — First Checkpoint (BEFORE everything)

**BEFORE loading the rest of the skill**, categorize the request into 4 bands. This determines WHETHER to load the skill. Subagent numbers are in the Tier Auto-Detection table (Phase 0a) — this table is a pure on/off switch.

| Band | Examples | Load skill? | Loop? |
|------|----------|-------------|-------|
| **Low** | typo, fix bug, rename, single command | ❌ No (saves 8K tokens) | No, direct |
| **Medium** | add endpoint, create function, test, refactor | ✅ Yes | 1 iteration |
| **High** | system, auth module, full API, multi-file feature | ✅ Yes | ∞ converge |
| **Extreme** | full-stack, e-commerce, MVP from zero, 50+ files | ✅ Yes | ∞ + orchestrator |

**Token saving rule:**
```
IF band == "low":
└─ DON'T load SKILL.md (8K tokens saved)
└─ Execute directly: read, edit, commit, push
└─ No loop, no subagents, no plan
IF band == "medium":
└─ Load SKILL.md, fast path: decompose → dispatch → gather → done
└─ Max 1 retry, no self-learning
IF band == "high" or "extreme":
└─ Load full SKILL.md
└─ Full loop with all phases
└─ Self-learning active
```
**When in doubt, prefer the HIGHER band.** It's better to load the skill for a medium task and discover it was low, than to skip it for a high task.

#### 🔨 Hard Trigger Activation (bypass 4-Band Filter)

If the user explicitly includes these keywords in their goal, **the 4-Band Filter is bypassed** and the loop activates at Tier 2 minimum (never skipped):

| Trigger Keyword | Effect |
|----------------|--------|
| `"attiva elysium"`, `"modalità elysium"`, `"elysium mode"`, `"swarmloop"` | Bypass filter → force loop activation |
| `"MAX EFFORT"` / `"max effort"` | Bypass filter + activate Quality-First Mode (see Phase 0a) |
| `"SWARMLOOP MODE"` / `"swarmloop mode"` | Bypass filter + activate Swarmloop Mode (Phase 0.7) |
| `"MESM"` / `"mesm"` | Bypass filter + Quality-First AND Swarmloop Mode together (Max Effort Swarmloop Mode) |

**Rule**: these keywords override band detection. Even a "Low" request like "fix typo" becomes Tier 2 if prefixed with "attiva elysium, fixa il typo".
**Case handling:** ALL triggers are **case-INSENSITIVE** — caps, lowercase, and mixed case all activate. The caps forms are the canonical spellings, not a requirement. If a low-band task contains these words incidentally, the loop activates anyway: a false positive costs one iteration, a missed trigger costs the whole mode.
---
## The Core Loop
```
while goal\_not\_achieved:
state = assess(goal, done, gaps)
if state.is\_done: break
decide() # what to do next based on state
decompose() # break remaining work into tasks
scatter() # dispatch all in parallel
stream() # process each result as it arrives
# immediate retry on failures
learn() # save patterns, calibrate, improve
```
---
## 🚀 Quick Start
```
GOAL: "Crea sistema di prenotazione ristorante"
1. STATE INIT → tier 3, 50 subagenti, soglia 7/10
2. DECOMPOSE → 40 task atomici su 40 file diversi
3. SCATTER → dispatch 40 subagenti in parallelo
4. STREAM → processa streaming: 42 pass, 8 fail → retry immediati
5. CONVERGE → 3 iterazioni, 100% pass
6. LEARN → salva pattern "decomposizione per\_file per CRUD"
7. REPORT → first-pass 84%, qualità 8.6/10, 5 minuti
```
---
## Phase 0 — Autonomous Loop Engine (ALWAYS ACTIVE)
### 0a — State

```python
STATE = {
    "goal": "", "tier": auto_detect(), "quality_threshold": tier_to_threshold(tier),
    "subagents_available": 100, "subagents_used": 0,
    "tasks_completed": [], "tasks_failed": [], "tasks_in_flight": [],
    "iteration": 0, "max_iterations": auto_calc(tier),
    "first_pass_rate": None, "avg_quality_score": None,
    "self_lessons": [], "codebase_familiarity": "unknown",
    "quality_first": False, "swarmloop_mode": False, "global_recheck": False,
    "clarify_mode": False, "plan_approved": False, "plan_file": "", "start_time": now(),
}
```

**Tier Auto-Detection:**
| Tier | Subagents | Threshold | When |
|------|-----------|-----------|------|
| 1 | 1-3 | 6/10 | Single edit, 1 file, ≤2 keywords |
| 2 | 5-15 | 7/10 | 1-3 files, CRUD, < 1h |
| 3 | 15-50 | 7/10 | 3-10 files, auth+CRUD+services |
| 4 | 50-100 | 8/10 | 10+ files, greenfield, cross-system |

**Word-boundary matching:** `\bapi\b` not "api" inside "/api/users/". Single endpoint + model = Tier 2.
**Tier 1 Fast-Path:** ≤2 files + no deps = skip loop entirely, direct execution.

**Codebase Familiarity Override:**
| Knowledge | Adjustment |
|-----------|-----------|
| Never seen | Standard tier |
| Explored before | -50% subagents |
| Know by memory (5+ files) | -80% or 0 |
| Wrote the module | 0 subagents, direct |

**Quality-First Mode:** trigger `"MAX EFFORT"` (case-insensitive — any case activates) → threshold 9/10, max_iterations 9, fine granularity, Global Re-Check enabled.

**State Initialization:** `bash scripts/init-state.sh "goal"` (or `--quality-first`, `--clarify`, `--plan-file`, `--structural-scan`, `--json`).
### 0b — Assess

```
ASSESS: (1) completed? (2) failed + gaps? (3) in-flight? (4) goal reachable? (5) adjust strategy? (6) past patterns? (7) tier correct?
```

### 0c — Decide

```
if in_flight → stream | elif failed & <max → retry | elif failed & >=max → escalate
elif not started AND NOT plan_approved → get_approval | elif not started → decompose
elif done & OK → COMPLETE | elif done & LOW → quality loop
```

---

## Phase 0.5a — Clarification Interview

Before decomposing (Tier 3+), ask 5-6 questions in one message:
1. DB: SQLite (default), PostgreSQL, or other?
2. Frontend: None (default), React, Vue?
3. Auth: JWT (default), session, or none?
4. Deploy: local (default), Docker, cloud?
5. Scope: MVP (default), complete, or production-ready?
6. Testing: minimal (default), comprehensive, or TDD?

User can answer inline or say "fai tu" to use defaults. 2 min of questions saves 20+ min of wrong-assumption retries.

**⚠️ APPROVAL CHECKPOINT (smart, opt-in):** After user answers (or defaults accepted), summarize the chosen architecture decisions. Then:
1. User already said "fai tu" / "procedi" / "auto-approve" this session → proceed immediately (`plan_approved = True`), do NOT ask again — the user waived this checkpoint.
2. Task is Tier 4, greenfield, new domain, or involves real money (API keys, cloud) → WAIT for explicit confirmation before Phase 0.5b.
3. User asks for changes → revise and re-confirm.
The checkpoint prevents wrong assumptions; it must never become friction the user already waived.

---
## Phase 0.5b — Plan Integration (Project Document System)

Before dispatching (Tier 3+), create/update these 4 standardized documents in `.hermes/plans/{project}/`:

### Document Templates

| Document | Purpose | Created when |
|----------|---------|-------------|
| `AGENTS.md` | Durable conventions, boundaries, tech stack | Once, updated when conventions change |
| `SPEC.md` | Requirements, acceptance criteria, non-goals | Tier 3+ first run, updated on scope change |
| `ROADMAP.md` | Ordered phases, dependencies, risks, exit criteria | Tier 3+ first run, updated per phase |
| `TASKS.md` | Current actionable work with validated status | Every decomposition, updated per batch |

### SPEC.md Template
```markdown
# {Project} Specification
## Problem — {1-line summary}
## Users — {who, context, platform}
## Requirements — {numbered, testable}
## Acceptance Criteria — {observable outcomes}
## Non-Goals — {explicitly out of scope}
## Architecture — {chosen approach from Phase 0.6}
## Security & Privacy — {relevant concerns}
## Compatibility — {OS, runtime, dependencies}
```

### ROADMAP.md Template
```markdown
# {Project} Roadmap
## Phase 1: {name} — {goal} — exit: {criteria}
## Phase 2: {name} — {goal} — depends on: Phase 1
## Risks — {per phase: likelihood, mitigation}
## Validation — {automated + manual per phase}
```

### TASKS.md Template
```markdown
# {Project} Tasks — Phase {N}
| ID | Task | Files | Status | Score | Agent |
|----|------|-------|--------|-------|-------|
| T1 | {desc} | {path} | ⬜ pending | - | - |
| T2 | {desc} | {path} | ✅ done | 8/10 | A3 |
```

**Tier scope:** the full 4-document system is for Tier 4 / greenfield / new domains only. Tier 3 with known conventions → `SPEC.md` + `TASKS.md` only. Tier 2 / ≤5 files → minimal plan below. Never write 4 documents for a task that fits in one.

### Minimal plan (Tier 2, ≤5 files)
For Tier 2 or ≤5 files, a simplified plan in `.hermes/plans/{goal_type}/{date}.md` with:
- File manifest: exact files to create/modify
- Dependencies: build order
- Interface contracts: function signatures between modules
- Task assignments: which subagent works on what

**⚠️ APPROVAL CHECKPOINT (smart, opt-in):** After writing the plan documents, present a summary to the user. Then:
1. User said "fai tu" / "auto-approve" this session → proceed (`plan_approved = True`), no wait.
2. Tier 4 / greenfield / new domain / money involved → WAIT for approval before dispatch.
3. User requests changes → revise documents and re-present.
4. Plan approval is tracked in STATE: `plan_approved = True/False`.

Without a plan file, two subagents can modify the same `__init__.py` → conflicts.

---
## Phase 0.5c — Structural Alignment

If project exists (not greenfield), scan before creating files:
```
1. ls -R <path> | head -50    (directory structure)
2. Find *.py and check naming conventions
3. Find package.json/pyproject.toml (tech stack)
4. Inject conventions as quality criteria in every subagent
```
New code matches existing code style. No "why is this file here" surprises.

---

## Phase 0.7 — Swarmloop Mode (explicit opt-in, gauntlet-style loop)

A mode for goals where an EXTERNAL concrete bar exists (or can be found): builder/critic separation with fresh-context critics, open-ended rounds, per-round user check-ins. Inspired by Matt Shumer's Gauntlet Loop (somethingbig.ai/gauntlet-loop). Works for ANY domain — code, writing, research, design, marketing — not just games/visuals.

**Activation — ONLY on explicit user request** (never from band detection, never automatic):
| Keyword (case-insensitive) | Effect |
|----------------------------|--------|
| `"SWARMLOOP MODE"` | Force loop + Swarmloop Mode |
| `"MAX EFFORT"` | Force loop + Quality-First Mode only |
| `"MESM"` | Force loop + Quality-First AND Swarmloop Mode together (Max Effort Swarmloop Mode) |

Any case variant (lowercase, caps, mixed) triggers. The caps forms are canonical names, not a filter.

STATE: `swarmloop_mode = True`.

### 0.7a — Pre-Flight Cost Check (HARD GATE)
Before ANY dispatch, compute a REAL estimate from known numbers: `planned_subagents × estimated_rounds × summary_token_cap` (caps from Phase 3d: Tier 2 <500, Tier 3 <1000, Tier 4 <2000 tokens/summary) → present as `~N subagents × M rounds × ~X tok` plus the budget cap that applies. WAIT for explicit confirmation. Options: (a) full run, (b) cap rounds, (c) cap budget in tokens (or in $ ONLY if the user supplied a budget), (d) critics on cheaper model, (e) cancel. NO subagent is dispatched before confirmation.
⚠️ **NEVER invent a $ price:** the token-per-dollar price of the current model is not known to the agent — state tokens only. Fabricating a $ estimate violates the anti-fabrication hard rules (Phase 3g-bis). This gate exists because Swarmloop Mode burns tokens at maximum rate. `"MESM"` (both modes) MUST be flagged as the most expensive configuration.

### 0.7b — The Bar (mandatory, concrete, inspectable)
"Make it amazing" / "production-ready" is NOT a bar. Resolution order:
1. User-provided reference (screenshots, sites, texts, test suite, latency target, reference implementation)
2. Loop finds one: "find a concrete comparison/measurement that plays the same role for this task that real Call of Duty screenshots played for the Claude of Duty game. Explain why it is a useful bar, then judge every round against it."
3. Ask the user via clarify
No round starts without an inspectable bar.

### 0.7c — Round Mechanics (split → build → judge → repeat)
```
for each piece:
  builder builds (fresh subagent, goal + piece + bar, NOT the architecture)
  critic = NEW subagent with FRESH context (never the builder's history or explanations)
  critic inspects the REAL artifact (files, running product, tests, rendered output — never a builder summary)
  blind A/B when possible: critic sees our output and the reference, not told which is which
  if bar wins → critic names the BIGGEST gap → builder fixes it → next round
  else → piece passes
```
- **Rounds are open-ended**: no fixed max_iterations. Stop when: bar beaten, budget cap hit, or user says stop.
- **Per-round check-in (HARD)**: after each round report accumulated cost + win/loss vs bar + gap closed → ask "continue?" The run NEVER advances a round without explicit user go.
- **Budget caps**: `max_swarmloop_rounds` (default 3) and `max_swarmloop_subagents` (default 50) from user_preferences; optional $ cap from pre-flight option (c). Hard stop on hit → report → ask.
- **Live progress page**: maintain `workbench.md` (or a simple HTML page) updated every round with screenshots/drafts/test results/notes — the user watches progress without interrupting the run.
- **Watch, don't interrupt**: user says "stop"/"basta" → halt at the next check-in. Hermes /stop always works.

### 0.7d — Smoothing Pass (per wave)
After each major wave, spawn ONE fresh agent to inspect the complete result: fix conflicts, align interfaces, make pieces feel like one artifact (NOT a redesign). Aligns with Phase 3g assembly task (runs before commit).

### 0.7e — Cost Levers & Active Guardrails
- Critics can run on a cheaper model (config `delegation`/`auxiliary`) for TEXT tasks — visual criticism needs the strong model (Phase 3a-quinques cost rule applies).
- ALL standard guardrails stay active: 450s timeout + degradation (3d/3j-bis), escalation ladder (3j), security shield (3a), git policy (3g), context protection (3d), self-learning guardrails (4e), PR readiness (3g-bis).
- Round check-ins supersede max_iterations ONLY inside Swarmloop Mode; the standard loop is unchanged.

---

## Phase 1 — Task Decomposition
### 1a — Dynamic Granularity
Decomposition adapts to available subagents:
| Subagents | Granularity |
|-----------|-------------|
| 1-5 | Per-file (model.py, routes.py, services.py) |
| 5-15 | Per-function (each endpoint, each test suite) |
| 15-50 | Per-component (User model, Auth routes, Validation) |
| 50-100 | Per-line + multi-variant (3 implementations, pick best) |
```python
def decompose(goal, available, iteration):
if iteration == 0: return fine\_grained(goal, count=available \* 0.8)
else: return fine\_grained(gaps, count=len(gaps) \* 3)
```
### 1b — Scale Patterns

| Pattern | Subagents | When |
|---------|-----------|------|
| Micro-Task Cascade | 50-100 | Big project, one file per task |
| Multi-Variant + Selection | 30-50 | Critical component, pick best |
| Research → Implement → Test | 50-100 | Need research first |
| Full System Build | 80-100 | Greenfield full-stack MVP |
| Data Pipeline | 50-100 | Multi-source ETL, transform, merge |
### 1c — Clean Code Standards (by Tier)
**Do NOT apply to Tier 1** (quick fixes) or **non-code tasks** (logical deduction, security analysis). For Tier 2-4 code tasks, these are **mandatory** in subagent quality criteria:

```
CLEAN CODE STANDARDS (injected into quality criteria — CODE TASKS ONLY):

1. TYPE HINTS & DOCSTRINGS (Tier 2-4 code):
   ├─ Every function must have explicit type hints (params + return)
   ├─ Every public function must have a concise docstring
   └─ Validation phase checks type hint presence

2. SINGLE RESPONSIBILITY (Tier 3-4, via Actor-Critic):
   ├─ One function/class does ONE thing
   ├─ If an API route does DB query + business logic + email → ❌ FAILED
   └─ Verified by Actor-Critic, not automatic regex

3. DRY (Tier 3-4, via Assembly Task):
   ├─ If two subagents produce duplicate code, extract to shared module
   └─ Verified by Assembly Task (Phase 3g point 6)

4. ERROR HANDLING (Tier 2-4 code):
   ├─ External calls (DB, API, filesystem, network) MUST have error handling
   ├─ FastAPI: `raise HTTPException(status_code=...)` counts as error handling (idiomatic pattern)
   ├─ Generic: `try/except Exception as e` counts
   ├─ Bare `except:` without Exception class → ❌ FAILED
   └─ Verified by Phase 3b check 5

5. FILTER: skip ALL checks if task_type is NOT code
   └─ text/analysis tasks (logical_deduction, code_review, security_analysis) → skip Phase 1c
```
### 1d — Shared Interface Contracts (pre-dispatch)

If subagent A calls functions from subagent B, document exact signatures in BOTH contexts:
```
--- INTERFACE CONTRACT ---
Called: app/client.py — build_prompt(location: GeoResult, target_date: date) -> str (SYNC)
Caller: app/router.py — from client import build_prompt; result = build_prompt(loc, d)
--- END CONTRACT ---
```
Eliminates 90% of integration bugs. If Batch 1 already started, Batch 2 adapts to its signatures.

### 1e — Dynamic Quality Criteria

```python
criteria = {"completeness", "correctness", "edge_cases"}
if task_type == "api": criteria += {"status_codes", "validation", "tests"}
if task_type == "model": criteria += {"constraints", "repr", "migration"}
if task_type == "ui": criteria += {"responsive", "states", "anti-slop", "design_system", "no_generic_ai"}
```

### 1f — Frontend/UI Design (CONDITIONAL — only if user requests UI)

**⚠️ ACTIVATES ONLY when user explicitly requests:** interface, frontend, UI, dashboard, componente visuale, pagina, layout, design, form, landing, app con interfaccia.

**If user doesn't mention UI → SKIP entirely.** This section is NOT for backend-only tasks.

#### Stack Decision (before decomposition)

| User says | Stack chosen | Decision |
|-----------|-------------|----------|
| "React", "Next.js", "componenti" | React + TypeScript | User specified |
| "Vue", "Nuxt" | Vue 3 + TypeScript | User specified |
| "vanilla", "senza framework" | HTML + CSS + vanilla JS | User specified |
| Nothing specified | **ASK via clarify** | Don't assume |

**Rule:** all parallel subagents MUST use the SAME stack. Inject stack choice into every subagent context via Interface Contract (Phase 1d):
```
--- STACK CONTRACT ---
Framework: React 18 + TypeScript
Styling: Tailwind CSS v4
State: Zustand (or React Context for simple cases)
Build: Vite
All components MUST use this stack. No mixing.
--- END CONTRACT ---
```

#### Design Tokens Schema (mandatory before decomposition)

Every UI task MUST start with a `design-tokens.ts` (or `.css`, `.json`) file. All subagents reference this file for consistency.

```
DESIGN TOKENS FILE (minimum structure):
├─ colors: { primary, secondary, accent, bg, surface, text, muted, error, success, warning }
├─ typography: { fontFamily, fontSize (xs/sm/base/lg/xl/2xl), fontWeight (normal/medium/bold), lineHeight }
├─ spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px', 12: '48px' }
├─ radius: { sm: '4px', md: '8px', lg: '12px', full: '9999px' }
├─ shadows: { sm, md, lg } (max 3 levels, not "everything has a shadow")
└─ breakpoints: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px' }
```

**Validation:** every hex color, font-size, spacing value in component files MUST appear in design-tokens. Fail if >3 unmapped values found outside the tokens file.

#### Anti-Slop Validation (verifiable checks)

| # | Check | Method | Pass | Fail |
|---|-------|--------|------|------|
| 1 | **Glassmorphism** | `grep -c "backdrop-filter:\s*blur" *.css *.tsx` | ≤20% of component files | >20% |
| 2 | **Generic gradients** | `grep -c "linear-gradient.*purple\|linear-gradient.*#6366f1" *.css` | 0 matches | ≥1 match without data-driven purpose |
| 3 | **Soft shadow spam** | `grep -c "box-shadow" *.css` | ≤1 per component avg | >2 per component avg |
| 4 | **Rounded-xl spam** | `grep -c "border-radius:\s*1[6-9]px\|border-radius:\s*2[0-9]px" *.css` | ≤30% of components | >30% |
| 5 | **Placeholder text** | `grep -ri "lorem ipsum\|placeholder\|sample text\|coming soon" *.tsx *.html` | 0 matches | ≥1 match |
| 6 | **Stock illustrations** | `grep -ri "unsplash\|undraw\|storyset\|placeholder.*svg" *.tsx` | 0 matches | ≥1 match |
| 7 | **Token consistency** | Extract all hex colors from components → check against design-tokens file | ≤3 unmapped | >3 unmapped |
| 8 | **Animation trigger** | Every `@keyframes` or `transition` must have a corresponding state change (hover/focus/active/data-attr) | 100% have trigger | Any orphaned animation |

#### Accessibility Checklist (WCAG AA minimum)

| # | Requirement | Threshold | Verification |
|---|------------|-----------|-------------|
| 1 | **Contrast ratio — normal text** | ≥4.5:1 | Use contrast checker on all text/bg color pairs from design-tokens |
| 2 | **Contrast ratio — large text/UI** | ≥3:1 | Same check for text ≥18px or ≥14px bold |
| 3 | **Focus visible** | 100% interactive elements | Tab through all pages → every button/link/input must show visible focus ring |
| 4 | **No focus traps** | 0 traps | Tab through modals/dialogs → must be able to tab out |
| 5 | **Semantic landmarks** | `header`, `main`, `nav`, `footer` present | `grep -c "<header\|<main\|<nav\|<footer" index.html` ≥3 |
| 6 | **Keyboard navigation** | All interactive elements reachable via Tab | Manual tab-through test on each page |
| 7 | **aria-labels** | Every icon button, image, form input | `grep -c "aria-label\|aria-labelledby" *.tsx` ≥ count of interactive elements |
| 8 | **Skip-to-content link** | Present on pages with navigation | `grep "skip.*content\|skip.*main" *.tsx` ≥1 |

#### Application States Checklist

Every page/view MUST handle these states. Fail if any missing:

| State | Minimum requirement | Verification |
|-------|-------------------|-------------|
| **Loading** | Skeleton or spinner (not blank page) | `grep -c "skeleton\|spinner\|loading" *.tsx` ≥1 per page |
| **Empty** | Message + CTA (not empty div) | `grep -c "empty\|no.*data\|no.*results" *.tsx` ≥1 per data page |
| **Error** | Error message + retry button | `grep -c "error\|catch\|onError" *.tsx` ≥1 per API call |
| **Disabled** | Visual + aria-disabled on disabled elements | `grep -c "disabled\|aria-disabled" *.tsx` ≥1 per form |
| **Success** | Confirmation feedback (toast/inline) | `grep -c "success\|toast\|snackbar\|confirmed" *.tsx` ≥1 per mutation |
| **404/Not Found** | Custom 404 page or inline message | File exists: `*404*` or `*not-found*` |

#### Performance Checklist

| # | Check | Threshold | Verification |
|---|-------|-----------|-------------|
| 1 | **No duplicate dependencies** | 0 duplicate packages across subagent outputs | `grep "import.*from" *.tsx \| sort \| uniq -d` should be empty (shared deps in package.json, not duplicated) |
| 2 | **Lazy loading** | Heavy components (>500 LOC or chart libs) use dynamic import | `grep -c "React.lazy\|import(" *.tsx` ≥ count of heavy components |
| 3 | **Image optimization** | No images >200KB, use WebP/AVIF where possible | `find . -name "*.png" -o -name "*.jpg" \| xargs ls -la` → no file >200KB |
| 4 | **Bundle awareness** | No unused imports, tree-shakeable | `grep -c "import.*\*" *.tsx` should be 0 (no wildcard imports) |

#### Component Decomposition (when UI activated)

```
FRONTEND DECOMPOSITION:
├─ design-tokens.ts/css — 1 subagent (FIRST, before all others)
├─ Layout shell (header/sidebar/content) — 1 subagent
├─ Pages — 1 subagent per page (exclusive files)
├─ Shared components (Button, Input, Card, Modal) — 1 subagent
├─ State management (store/context) — 1 subagent
├─ API integration layer — 1 subagent
└─ Styles/config (Tailwind, CSS modules) — 1 subagent
```

**Order:** design-tokens FIRST (other subagents depend on it). Layout SECOND. Pages/components in parallel after layout is committed.
---
## Phase 2 — Hierarchical Scatter (Depth-2/3 Orchestration)
### 2a — Two-Level Hierarchy (+ B1-B6 Anti-Bottleneck)
With `max\_spawn\_depth: 2`, subagents can be orchestrators that spawn their own workers:
```
MAIN AGENT
└── delegate\_task(role="orchestrator", goal="Analizza e fixa modulo X")
├── worker "trova bug" (leaf, default)
├── worker "trova vulnerabilità" (leaf)
└── worker "propone fix" (leaf)
```
\*\*Rules:\*\*
- `role="orchestrator"` → subagent can use `delegate\_task(tasks=[...])` with leaf workers
- `role="leaf"` (default) → cannot delegate further
- Orchestrator collects worker results, synthesizes, returns summary
- Workers are always leaves at depth 2
\*\*For Tier 4 (Epic, 50+ files) — Depth-3 with B1-B6 Anti-Bottleneck Rules:\*\*
For very complex tasks, use 3-level hierarchy: Parent → Orchestrator → Leaf → Micro-worker.
\*\*6 Anti-Bottleneck Rules (B1-B6):\*\*
```
B1 — Mini-batch: max 5 leaf workers per orchestrator batch (not all at once)
B2 — Depth auto-limit by Tier: T1-2→1 level, T3→2 levels, T4→3 levels (only if >50 files)
B3 — Context snapshot: <200 token snapshot injected into every subagent
B4 — Retry degradation: retry 2 = inline by leaf, retry 3 = orchestrator does it inline
B5 — Aligned timeouts: micro 60s → leaf 120s → orch 240s → parent 300s
B6 — can\_dispatch() mandatory before every batch (see Phase 3d)
```
\*\*Leaf Dynamic Split:\*\* a leaf that evaluates its task as too complex (3+ files with dependencies, estimate >120s) can spawn MAX 2 micro-workers. Micro-worker is dead-end (cannot spawn further). Context snapshot injected. If both fail → leaf implements inline (B4).
### 2b — Streaming Dispatch (wave-based)

Instead of one big `delegate_task(tasks=[...])`, dispatch in waves:
- Decompose goal into N tasks
- Dispatch BATCH 1 (tasks 1-25), prepare BATCH 2
- On first result → evaluate IMMEDIATELY → retry below-threshold without waiting
- Retries interleave naturally. Zero dead time between batches.
- **⚠️ Safety:** every batch MUST pass `can_dispatch()` (Phase 3d) before starting.

### 2c — Subagent Prompt Template (self-aware)

Every subagent knows it's part of a larger loop:

```
TASK: {description} | YOUR ID: {task_id} | THRESHOLD: {threshold}/10 | MAX ITERATIONS: 3
QUALITY CRITERIA: {custom_criteria}
SELF-AWARENESS: You are one of {total_tasks} parallel agents. Evaluated automatically. Below threshold = retry with feedback.
INSTRUCTIONS: (1) implement fully (no stubs/TODO), (2) self-verify, (3) fix if below threshold (max 3 tries), (4) return honest score + gaps.
PARTIAL SAVE: write partial results to .partial file every 120s. On timeout, main agent reads it.
RETURN FORMAT: ## RESULT - task_id - status: pass|fail|partial - quality_score: N/10 - gaps: [list] - files_created: [paths]
```
### 2d — Streaming Gather

```
while goal_not_achieved AND iteration < max:
  result arrives → parse status, score, gaps, files_created → validate files exist, no stubs
  if score >= threshold → mark complete | if score < threshold → IMMEDIATE RETRY (don't wait)
  update first_pass_rate, avg_quality
  if ALL accounted for AND all passed → 🎉 GOAL ACHIEVED
```

### 2e — Pre-Dispatch Validation

```
□ Each task has DIFFERENT files (no conflicts) | Load balanced (no task > 2× average)
□ Task count <= available subagents | Interface contracts documented (Phase 1d)
□ Assembly task planned for shared files (Phase 3g) | can_dispatch() passed (Phase 3d)
```
---
## Phase 3 — Streaming Quality Gate
### 3a — Security Shield AUTO (regex-based, ALL tiers)
\*\*Applied to ALL code-producing tasks, even Tier 1.\*\* If a check fails → immediate retry with specific feedback.
```
SECURITY AUTO CHECK (run after file validation, before quality gate):
1. ZERO HARDCODED SECRETS (CRITICAL — blocks task):
├─ Regex: \b(api\_key|password|secret|token|api\_secret)\s\*=\s\*['\"][^'\"]{8,}
│ WITHOUT os.getenv / env / process.env in next 3 lines
├─ Blocks: "API\_KEY = 'sk-abc123...'", "password = 'admin'"
├─ OK: "API\_KEY = os.getenv('API\_KEY')", "password = get\_secret()"
└─ If found → ❌ RETRY: "Move credential to environment variable"
2. SQL INJECTION RISK (HIGH — blocks task):
├─ Regex: (f['"]SELECT|f['"]INSERT|\.format\(.\*SELECT|\+ .\*SELECT|execute\(.\*\+)
├─ Blocks: f"SELECT \* FROM users WHERE id={user\_id}"
│ "SELECT \* FROM " + table\_name
├─ OK: cursor.execute("SELECT \* FROM users WHERE id=?", (user\_id,))
│ session.query(User).filter(User.id == user\_id) [ORM]
└─ If found → ❌ RETRY: "Use parameterized queries or ORM, never f-string SQL"
3. PLACEHOLDER SECRETS (warning — doesn't block):
   ├─ Regex: \b(API_KEY|TOKEN|SECRET)\s*=\s*(['"]\s*['"]|None|''|"")\s*#\s*TODO
   └─ If found → ⚠️ WARNING (may be intentional)

4. DEPRECATED API PATTERNS (HIGH — blocks task):
   ├─ Regex: \.__fields__\b|\.dict\(\)|\.json\(\)|pydantic\.v1|from typing import.*Type|@app\.route\([^)]+\)\s+\ndef
   ├─ Blocks: Pydantic v1 __fields__ access, bare .dict()/.json() calls, old typing imports
   ├─ EXCLUDES: files in /tests/, /test_*.py, /conftest.py (external test code uses hasattr(..., '__fields__') legitimately)
   ├─ OK: SQLAlchemy/SQLModel patterns, @app.route with HTTP methods, hasattr check in test files
   └─ If found → ❌ RETRY: "Use current version APIs — check for deprecation alternatives"

5. DANGEROUS SHELL COMMANDS (CRITICAL — blocks task, pre-execution):
   ├─ BLOCKED patterns (never allowed): rm -rf /, chmod 777 /, dd if= of=/dev/, :(){ :|:& };:, > /dev/sda
   ├─ WARN patterns (require user confirmation): rm -rf, chmod -R 777, curl | bash, eval, sudo without explicit scope
   ├─ ALLOWED patterns (safe commands): git, npm, pip, python, pytest, cargo, go, docker, kubectl, gh
   ├─ Rule: before any terminal() call, check command against BLOCKED list → if match, refuse and explain
   │        Check against WARN list → if match, ask user confirmation via clarify()
   │        All other commands → allow (default-allow, not default-deny)
   └─ If blocked → ❌ REFUSE: "Command blocked by security policy. Use safer alternative."

   ENFORCEMENT LAYER: Hermes's own approval system is the final authority — this
   list is a fast pre-check, not a substitute. If Hermes prompts for confirmation
   on a WARN command, surface the prompt to the user (never auto-approve).
```
### 3a-quinques — Parallel Sandbox Racing

For critical tasks: 3-5 identical subagents in parallel, first to pass wins.

**When to activate:**
| Condition | Racing? |
|-----------|:-------:|
| First attempt (iteration 0) | ❌ No |
| Critical task (Tier 3+, hotfix) | ⚡ Auto |
| After 1 retry failed | ✅ 2 variants |
| After 2 retries failed | ✅ 5 variants |
| Quality-First Mode | ✅ Always 5 |

**Rules:** Different approach hints per variant. First to pass all gates wins. Max 5 variants. Never for shared files.
**⚠️ COST:** N variants = N× tokens. Use only for critical/hotfix where time > cost.

### 3b — Physical File Validation (MANDATORY for Tier 2-4)
**Not optional anymore.** Every code-producing task MUST pass this before being marked complete. Doc/config tasks → skip.
```
VALIDATE RESULT (mandatory for code tasks):
1. read_file(task.files_created[0]) — exists? → if not, ❌ fail immediate
2. grep -n "TODO\|pass\|stub" task.files_created — dead code? → ❌
3. python -c "from task.module import ..." — syntax ok? → ❌
4. wc -l task.files_created — file not empty? → ❌
5. FORMAT & ERROR HANDLING VALIDATION (for data/DB/API tasks):
   ├─ For SQL tasks: verify parameterized queries — grep for "?" or "%s" or ":param" after "execute("
   │   └─ If raw string interpolation found → ❌ RETRY: "Use parameterized queries"
   ├─ For API tasks: verify error handling — grep for "try:" OR "HTTPException" after external calls
   │   └─ If neither found → ❌ RETRY: "Add error handling (try/except or raise HTTPException)"
   ├─ For data analysis tasks: verify output format matches expected schema
   │   └─ Check: output type matches spec (dict, list, DataFrame, str)
   └─ For ALL tasks: grep for deprecated patterns from Phase 3a check 4
       └─ EXCLUDES: files in /tests/, /test_*.py, /conftest.py
       └─ If found → ❌ RETRY with specific deprecation feedback
```
If physical validation fails → **immediate retry with specific feedback** (no silent failure).
### 3c — Execution Reality Check (for standalone scripts and tests)
For \*\*standalone scripts, pure functions, or unit tests\*\*, run the code in sandbox:
```
EXECUTION CHECK (only for sandboxable tasks):
1. Run pytest test\_file.py or python script.py in sandbox
2. If stderr empty → ✅ pass
3. If stderr has errors:
├─ Use the EXACT error as retry feedback
├─ Max 3 fix attempts based on stderr
└─ If still failing → escalate to Phase 3j
DO NOT run if task requires:
├─ External DB/network connections
├─ Real filesystem (use tmpfile)
├─ Tokens/auth/API keys
└─ Listening server
```
### 3d — Context Window Protection (CRITICAL for Tier 3-4)

100 summaries = 200K tokens → context overflow → death spiral.

```
CONTEXT BUDGET RULES:
1. If N_subagents × 2000 > context_budget × 0.6 → REDUCE batch (2-3 waves)
2. Wave dispatch: batch > 20 → waves of 20, collect → process → free context
3. Summary compression: Tier 2 <500 tokens | Tier 3 <1000 | Tier 4 <2000
4. 2+ compression triggers → context saturated, reduce subagents
4. Compression death spiral prevention:
   ├─ If context compression triggers 2+ times in one session:
   │   └─ ⚠️ CONTEXT SATURATED — reduce subagents or summary size
   │   └─ Switch to smaller wave dispatch
   └─ Never ignore compression triggers — they signal overflow

5. HARD TIMEOUT GUARD (PREVENTS SILENT FAILURES):
   ├─ HARD CAP: 450s per task. On timeout → kill subagent, DO NOT leave at 0/100
   │   └─ Generate partial result: what WAS produced, what was missing. Score: 4/10 minimum.
   ├─ TIMEOUT ESCALATION: 1st → re-dispatch as 2 smaller | 2nd → inline | 3rd → Phase 3j-bis
   └─ TIMEOUT RATE TRACKING: >10% timeout → reduce batch 50% | >25% in 3 batches → downgrade Tier
```

**Cost:** 100 summaries saturate context → compression death spiral. Wave dispatch + summary compression prevent this.

### 3d-bis — Output Filtering (optional, recommended for Tier 3-4)

For verbose command output (test suites, builds, linters, logs, dependency listings), filter BEFORE it reaches the context window. Three options, in order of preference:

```
OUTPUT FILTERING RULES:
1. NATIVE PIPES (always available, no dependencies):
   ├─ cmd 2>&1 | grep -E "FAILED|ERROR" | head -50   (errors only)
   ├─ cmd | tail -N / cmd | head -N                  (truncate)
   ├─ cmd | sort | uniq -c | sort -rn                (aggregate)
   └─ Works everywhere — use this FIRST.

2. RTK (optional, ONLY if already installed):
   ├─ Check availability first: `which rtk` (or `rtk --version`)
   ├─ If present → use [RTK](https://github.com/rtk-ai/rtk) for large/repetitive output
   ├─ Install (optional): cargo install --git https://github.com/rtk-ai/rtk
   │  └─ NOT cargo install rtk (different crate on crates.io)
   └─ If cargo/rtk missing → skip silently to option 1. NEVER block a task on an install.

3. RAW COMMAND when:
   ├─ Output is expected to be short
   ├─ Exact or complete output matters
   └─ Inspecting a specific file or narrowly scoped result

If a filter hides needed detail → rerun the command raw. Never filter merely to satisfy a convention.
```

**Integration with Phase 3d:** output filtering complements wave dispatch by reducing per-command token cost. Together they prevent context death spiral.

### 3e — Adaptive Threshold Tuning (next batch only)

```
FPR < 60% after 25% of tasks → double granularity (split each in 2)
FPR > 90% after 25% of tasks → merge adjacent tasks
⚠️ NEVER change already-dispatched tasks — overlaps and conflicts.
```

### 3f — Actor-Critic Escalation (3+ retries only)

Not for every task. Analyzes failure pattern after 3+ retries: same error → context problem | different errors → execution problem | worsening → circular learning | stalemate → poorly specified.
Action: rewrite task, split, or escalate. Limit: 1 attempt per task.

### 3g — Git Commit+Push Policy (MANDATORY)

```
1. Task PASSES quality gate + files validated → git add + commit + push (exclusive files only)
2. SHARED files (router, __init__, config) → WAIT for assembly task post-batch
3. DO NOT commit in-flight task files (conflicts)
4. Commit format: conventional commits (feat/fix/test:)
5. Push fails → single retry, continue loop. Report "N commits not pushed" in final.
6. ASSEMBLY TASK: after ALL batch tasks verified → modify shared files, DRY check, commit + push
```
\*\*Why in the loop and not at the end:\*\* granular commits after every task = rollback possible for single task if a later task breaks it. Single final commit = all-or-nothing.

### 3g-bis — PR Readiness Workflow (CONDITIONAL — only when a PR workflow exists)

**Condition:** run this checklist ONLY if the repo uses PRs/CI/reviews (user works with pull requests or explicitly asks for a PR). Direct-to-main workflows — local repos, single-user projects, quick iterations — skip gates 1-5 and go straight to commit+push (Phase 3g). The anti-fabrication hard rules at the end apply ALWAYS, in every workflow.

After all batch tasks pass and assembly task commits (PR workflow repos only), run this checklist before declaring the goal complete:

```
PR READINESS GATES (all must pass before GOAL ACHIEVED):

1. LOCAL REVIEW (mandatory):
   ├─ Inspect complete diff: git diff origin/main...HEAD
   ├─ Separate pre-existing changes from new work
   ├─ Run focused checks per module, then full test suite
   └─ Record exact commands + results

2. MANUAL TEST CHECKLIST (mandatory for Tier 3+):
   ├─ Define test scenarios from SPEC.md acceptance criteria
   ├─ Document: environment, steps, expected vs actual
   └─ Record evidence (screenshots/logs for visible changes)

3. HARD GATES (do NOT report done while any remain):
   ├─ Required CI is failed, pending, or on older commit
   ├─ Actionable review feedback is unresolved
   ├─ Required manual testing is incomplete or undocumented
   ├─ Branch contains unrelated changes, secrets, debug code, or generated junk
   └─ Planning documents (SPEC/ROADMAP/TASKS) no longer match implementation

4. PULL REQUEST EVIDENCE:
   ├─ Problem and implemented approach
   ├─ Important decisions and deviations from the plan
   ├─ Exact automated checks that passed
   ├─ Manual tests and their environment
   ├─ Screenshots or recordings for visible changes
   └─ Known limitations, skipped validation, and follow-up work

5. MERGE GATE (only when user explicitly requests):
   └─ Final diff, CI, reviews, threads, manual tests ALL clean → merge
   └─ Never merge without user authorization
```

**Hard rules:**
- Never fabricate commit hashes, review state, commands, or test results
- For uncommitted work, report `HEAD` together with worktree state
- When no PR exists, report remote checks/reviews/threads as N/A
- The builder's self-review is NOT a substitute for independent review

### 3h — Retry Intelligence

| Type | Score | Strategy |
|------|-------|----------|
| Superficial | 5-6 | Same task + feedback |
| Structural | 3-4 | Redefine + architectural hint |
| Critical | 0-2 | Rewrite, split into micro-tasks |
| Silent | N/A | Pivot inline |

### 3i — Convergence-Based Limits

```
if score improved ≥ 2 → continue (converging)
elif improved < 2 → change strategy (split, better hints)
elif WORSENED → stop, restart with smaller task
```

### 3j — Escalation Ladder

```
1. Self-verify → 2. Retry with feedback → 3. Change strategy → 4. ESCALATE TO USER → 5. User decides
```
**Rule:** never reach step 4 without 3 different strategies.

### 3j-bis — Graceful Degradation on Timeout

Problem: code_review/large refactors produce 0/100 on timeout — binary fail.

```
TIMEOUT GRACEFUL DEGRADATION (450s cap):
1. First timeout → re-dispatch as 2 smaller tasks, deadline "Return SOMETHING within 60s"
2. Second timeout → run yourself (inline), produce minimal viable version (stubs OK)
3. Third timeout → grep for patterns, return PARTIAL with explicit gaps
4. HARD RULE: Never 0/100 — always produce SOMETHING (5/100 > 0/100)
5. PRE-EMPTIVE SAVE: subagent writes .partial file every 120s → on timeout, read it for what was completed
```
### 3k — Global Re-Check Pass

Post-assembly: read ALL files for cross-module inconsistencies (signatures, naming, dead code, architecture).

**Activation triggers:**
| Condition | Re-Check? |
|-----------|:---------:|
| Quality-First Mode | ✅ Mandatory |
| Tier 4 (50+ files) | ✅ Yes |
| Tier 3 with 8+ files | ✅ Yes |
| 5+ cross-module deps | ✅ Yes |
| Tier 1-2 | ❌ Skip |
| < 8 files AND tier < 3 | ❌ Skip |
| Text-only tasks | ❌ Skip |

**Scans:** (1) signature consistency, (2) naming conventions, (3) dead code, (4) architectural layer violations.
**Resolution:** fail → create fix tasks, retry once. Still failing → include in final report.

---
## Phase 4 — Self-Learning Loop
### 4a — Pattern Capture (Gated — SkillOpt principle)

After every execution, patterns follow a **gated capture** flow inspired by microsoft/SkillOpt:

```
PATTERN CAPTURE FLOW:
1. Candidate generated: task completed → extract pattern (goal_type, decomposition, FPR, quality)
2. REJECTED CHECK: query rejected_patterns table for same goal_type/context
   └─ If match found → log "pattern already rejected for this context, see rejected_patterns"
   └─ Skip to Level 1 memory entry only (no cache promotion)
3. HELD-OUT VALIDATION (gate):
   └─ Select 3-5 tasks from same category that were NEVER used during pattern generation
   └─ Run candidate pattern on held-out tasks
   └─ Compare: candidate_score vs baseline_score (no pattern)
   └─ If candidate_score > baseline_score → ACCEPT → promote to stable cache
   └─ If candidate_score ≤ baseline_score → REJECT → log in rejected_patterns
4. STABLE/CANDIDATE SPLIT:
   └─ stable: patterns that passed the gate (in pattern_cache.json)
   └─ candidate: patterns under validation (in pattern_candidates.json)
   └─ Only stable patterns are consulted during Recall (Phase 4c)
```

**Persistence levels (gated):**

| Level | Where | Gate? | When |
|-------|-------|-------|------|
| 1. Memory Entry | Hermes memory store | ❌ Always (max 200 chars) | Last batch of session |
| 2. Pattern Cache (stable) | `skill_dir/pattern_cache.json` | ✅ Must pass held-out gate | FPR > 70% AND gate passed |
| 3. Dedicated Skill | `skill_manage(action="create")` | ✅ Must pass held-out gate | 3+ occurrences AND gate passed |

**Level 1 format:** `ES[goal_type|T{tier}] FPR={rate} dec={pattern} q={quality} iter={N} L: {lessons}`
**Level 2 consult:** at Phase 1 start, if goal_type matches cached pattern with FPR > 80% → use as template (saves ~2000 tokens).
**Level 3 trigger:** if same goal_type appears 3+ times with FPR > 75% → create skill.

### 4b — Adaptive Calibration
```python
def calibrate(history):
if len(history) < 3: return defaults()
avg = mean(h.first\_pass\_rate for h in history[-3:])
if avg < 0.6: return {"granularity": "fine", "threshold": threshold - 0.5}
if avg > 0.95: return {"granularity": "coarse", "subagents": subagents \* 0.7}
return {"granularity": "balanced"}
```
### 4c — Token-Efficient Recall (pre-loop sequence) — MANDATORY

**CRITICAL:** Recall is NOT optional. Skipping it is the #1 reason FPR degrades across sessions.

```
RECALL SEQUENCE (~1000 tokens):
1. Memory injection: ES[...] entries in context → match goal_type? → MUST use as template
2. Pattern cache (STABLE ONLY): read_file(skill_dir/pattern_cache.json) → FPR > 70%? → MUST use as template
   ⚠️ CRITICAL: pattern_cache.json MUST be saved to SKILL DIRECTORY, not ~/.hermes/ (sessions are isolated)
   ⚠️ ONLY stable patterns (passed held-out gate) are consulted — candidates are NOT used
3. REJECTED CHECK: read_file(skill_dir/rejected_patterns.json) → match goal_type/context?
   └─ If match → log "pattern already rejected for this context" → do NOT regenerate same pattern
   └─ Use rejection reason as negative feedback in decomposition
4. Skill list: pattern-{goal_type} exists? → load with skill_view
5. Dynamic Knowledge: read local-patterns.md + dynamic-patterns.md → inject as extra_criteria
6. Calibration: 3+ history entries? → calibrate BEFORE decomposing
7. FPR enforcement: FPR < 60% → finer granularity | FPR > 90% → coarser | never decompose from zero
```

**Enforcement:** pattern found but ignored → -5 penalty on final report. Token savings: 60-75%.
### 4d — Self-Learning Feedback Loop (cross-session)

**Cycle:** RECALL (read cache + memory) → EXECUTE (calibrated params) → CAPTURE (Level 1+2) → CALIBRATE (update params). After 3+ sessions with FPR > 75% → create skill (Level 3).
**Measurable:** FPR MUST increase over 5 sessions. If not → re-evaluate lesson format.
### 4e — Self-Learning Guardrails (CRITICAL — 10 guardrails, non-optional)

| # | Guardrail | Rule |
|:--|:----------|:-----|
| 1 | **Memory Budget Cap** | Max 10 ES[...] entries. If >8, replace oldest/lowest FPR. Never add — replace. |
| 2 | **Lesson Validation** | Only save evidence-based lessons (failed test → fix). Skip anecdotes, opinions, self-referential claims. Anti-circularity test: "If this lesson were wrong, how would I know?" |
| 3 | **Skill Mutation Protection** | Pitfalls/references/examples: auto-patch allowed. Philosophy/Tier/Quality/Guardrails/Phases: human confirmation REQUIRED. Max 1 patch/session. |
| 4 | **Skill Proliferation Cap** | Max 5 pattern-* skills total. Consolidate if >70% similar. Max 1 created/session. Archive if unused 30 days. |
| 5 | **Pattern Cache Cleanup** | Cleanup every 10 batches: keep ≤20 entries. If >50: EMERGENCY keep only 10 recent with FPR>70%. Delete goal_types with 3+ entries FPR<60%. |
| 6 | **Project Isolation** | Architecture/structure lessons = PROJECT-LOCAL (./.hermes/local-patterns.md). Pure technology (API/framework) = GLOBAL (~/.hermes/references/dynamic-patterns.md). When in doubt → LOCAL. |
| 7 | **Human Checkpoint** | skill_manage create/delete/edit → user confirmation. Patch pitfalls/references → notify after. Dynamic knowledge files ([Auto]) — autonomous. |
| 8 | **Session Memory Flush Cap** | Max 3 memory entries/session, 1 skill patch/session, 1 pattern_cache update (last batch only). Overflow → save top-N by impact. |
| 9 | **Drift Detection** | Every 5 sessions of same goal_type: compare FPR. If dropped >10% → stop saving, alert user, propose reset. |
| 10 | **Transparency Log** | Final report MUST list: entries saved/replaced, cache updated, skills patched/created, lessons validated/rejected, guardrails activated. |

**Self-learning is autonomous in DETECT (what to learn) but collaborative in ACT (structural changes need human consent).**
### 4f — Dynamic Knowledge Expansion (post 3+ retry) — Local/Global Split

**Trigger:** 3+ retries to pass quality gate → knowledge worth capturing.
```
1. Extract: What failed? Why? What solution worked?
2. Classify SCOPE:
   ├─ GLOBAL (pure tech: APIs, frameworks, languages) → ~/.hermes/references/dynamic-patterns.md
   └─ LOCAL (project architecture, conventions, wrappers) → ./.hermes/local-patterns.md
3. Auto-load: LOCAL always, GLOBAL filtered by technologies in goal
4. DEFAULT: when in doubt → LOCAL (harmless noise vs damaging context pollution)
```
### 4g — Lesson Hierarchy

| Priority | Type | Rule |
|:--------:|:-----|:-----|
| P0 | Structural | Always save (changes future decomposition) |
| P1 | Task-specific | Save if recurring (add extra quality criteria) |
| P2 | Context-specific | Save if project recurring (pitfall to check) |
| P3 | One-off | **NEVER save** — log in STATE only |

**Rule:** less but better. Max 2-3 lessons per batch.
### 4h — Skill Self-Improvement
- If a decomposition pattern succeeds 3+ times → save as reusable pattern
- If a pitfall is discovered → add to pitfalls section (general, not project-specific)
- Each self-improvement action bumps the skill version (following the v0.7.x scheme):
- Patch fix (v0.7.1) → new pitfall or minor calibration
- Minor improvement (v0.8.0) → new pattern or phase
- Major rewrite (v1.0.0) → breakthrough architecture change
---
## Phase 5 — Final Report

```
## ✅ [Goal]
### Loop Efficiency: subagents N/M | FPR XX% | quality X.Y/10 | duration X min
### Self-Learning: pattern saved, lessons, calibration, guardrails activated
### Quality: ✅ Passed X | ⚠️ Gaps Y | ❌ Escalated Z
### Self-Feedback: XX/100 | notes: [strengths + improvements]
```
---
## Phase 6 — Quality Matrix

**Scoring Rubric (0-10):**
| Score | Label | Action |
|-------|-------|--------|
| 10-9 | Flawless/Excellent | Accept |
| 8-7 | Good/Solid | Accept |
| 6-5 | Adequate/Weak | Retry with feedback |
| 4-3 | Poor/Bad | Redefine + split |
| 2-0 | Critical/Broken/Silent | Rewrite or pivot inline |

**Rules:** score = completeness + bonus (edge cases, tests) − penalty (stubs, conflicts). Ambiguous → lower bound. Silent (0) → immediate pivot.

**Per Task:** no stubs/TODO, edge cases, error handling, conventions, security shield, physical validation.
**Per Batch:** all delivered, files exist, no conflicts, no orphans, context OK, git checkpoint.
**Per System:** FPR saved, quality documented, pattern captured, calibration updated, goal achieved (not timeout).
---
## Phase 7 — Self-Execution Infrastructure

Supporting files in the skill directory: `scripts/init-state.sh` (bootloader), `references/pattern-store.sql` (SQLite schema), `scripts/install.sh` (installer), `scripts/session_manager.py` (state tracking), `scripts/e2e_test.py` (176 tests).

| MCP Server | Phase | Usage |
|-----------|-------|-------|
| **sqlite** | Phase 4, 7a | Pattern persistence, calibration |
| **graphify** | Phase 0b | Codebase context, dependency analysis |
| **sequential-thinking** | Phase 1, 3f | Complex reasoning, Actor-Critic |
| **github** | Phase 7e | GitHub sync, code review |

Cron: `cronjob schedule: "0 6 * * *"` for daily health scan, weekly refactor, on-demand deploy.
GitHub: `git add -A && git commit -m "v0.x" && git push origin main`. MIT license.
```bash
git add -A
git commit -m "v0.6 — description of improvement"
git push origin main
```
The skill is public (MIT license). Every meaningful improvement bumps the version.
---
## Phase 10 — Skill Ecosystem Integration

Complementary skills loaded during the loop:

| Phase | Skill | Why |
|-------|-------|-----|
| 1 (Decompose) | `test-driven-development` | RED→GREEN→REFACTOR for code tasks |
| 3 (Validation) | `verification-strategies` | When no test suite: curl, type checks, import checks |
| 3 (post-batch) | `requesting-code-review` | Security scan, quality gates, auto-fix |
| 3j (Escalation 1) | `systematic-debugging` | Root-cause analysis after 3 retries |
| 3j (Escalation 2) | `post-mortem` | 5 Whys + regression test + memory feed |
| Post-batch (T3+) | `deploy-release` | Version bump, changelog, deploy, health check |

---
## Phase 11 — Long Session Management

For sessions 2h+ with 30+ turns. Problem: quality degrades as context saturates.

**3 Mechanisms:**
1. **Session State File** — `SessionManager` tracks turns/decisions to `~/.hermes/sessions/` JSON. Context summary ~200 tokens.
2. **Automatic Checkpoint** — every 8 turns or 10 min: compress past turns, keep last 3 detailed.
3. **Quality Trend Monitor** — detect degradation in last 5 evaluations → alert + simplify next tasks.

**Interrupt Recovery:** `sm = SessionManager(id, goal); recovery = sm.recover()` restores state from disk.
**Context Summary** (when >60% saturated): `=== SESSION STATE: {id} === Goal: {goal} Turns: {N} Quality: {X}/10 Files: {list} Decisions: {list}`
- [{turn}] {decision}
Last checkpoint: turn {turn}
⚠️ Quality is degrading — simplify next tasks.
```
---
## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/init-state.sh` | Bootloader: auto-detect tier, --clarify, --quality-first, --plan-file, --structural-scan |
| `scripts/install.sh` | Auto-installer with --dry-run (preview), backup preservation, idempotent re-install |
| `scripts/e2e_test.py` | 176 checks across ALL phases, tiers 1-4 |
| `scripts/session_manager.py` | Session state tracking, checkpoint, quality trend, interrupt recovery |
| `scripts/pattern_cache.json` | Local pattern cache (created automatically, persists across sessions) |

Run validation: `python scripts/e2e_test.py`

---
## Pitfalls (condensed — 31 rules)

| # | Pitfall | Fix |
|:--|:--------|:----|
| 1 | Loop not autonomous (plan-plan-act) | assess → act → repeat |
| 2 | Streaming gather forgotten | Retry on first below-threshold result |
| 3 | Non-adaptive decomposition | Scale with available subagent slots |
| 4 | Scale patterns unused | Use multi-variant for 100 subagents |
| 5 | Self-learning skipped | Save patterns, calibrate, improve |
| 6 | Quality threshold ignored | Calibrate, don't ignore |
| 7 | Escalation hidden | Follow escalation ladder |
| 8 | Same decomposition for all goals | Match scale pattern to goal type |
| 9 | Idle during dispatch | Prepare retry templates while waiting |
| 10 | No physical file verification | Verify with read_file/stat |
| 11 | State not updated per result | Update after EVERY result |
| 12 | Overfitting self-learning | Need 3+ confirmations |
| 13 | Tier 4 for Tier 1 tasks | Fast-path exists for a reason |
| 14 | Context window overflow | Wave dispatch, summary compression |
| 15 | Security in subagent output | Always run Phase 3a Security Shield |
| 16 | No guardrails on self-learning | Phase 4e is NON-OPTIONAL |
| 17 | Signature mismatch (parallel) | Shared Interface Contracts (Phase 1d) |
| 18 | Clarification skipped (Tier 3+) | Always ask 5-6 questions first |
| 19 | Plan skipped (5+ files) | Write plan before dispatch |
| 20 | Sandbox Racing on shared files | Racing is for isolated bugfixes only |
| 21 | Skipping Phase 0.6 exploration | Tier 3+ defaults to 1st approach. Always run 3 scouts or load cached winner. |
| 22 | Ignoring auto-update notification | "v{NEW} available" means real improvements. Run git pull + /reload-skills. |
| 23 | Skipping approval checkpoint | Never dispatch Tier 4/greenfield/new-domain/money tasks without plan_approved=True. Lower tiers auto-approve when user said "fai tu". |
| 24 | Ad-hoc plan format (no templates) | Use SPEC/ROADMAP/TASKS templates from Phase 0.5b for Tier 4/greenfield. Structured docs prevent subagent conflicts and enable cross-session recall. |
| 25 | Declaring done without PR readiness | Run Phase 3g-bis gates ONLY in PR-based repos: local review, manual tests, hard gates, PR evidence. Direct-to-main repos skip to commit+push. |
| 26 | Installer overwrites without backup | Use --dry-run first, back up existing files, ensure idempotent re-install. Phase 7 installer must be safe to run repeatedly. |
| 27 | Dangerous shell command not blocked | Phase 3a check 5: scan all terminal() calls against BLOCKED/WARN/ALLOWED lists before execution. Hermes approval system remains the final enforcement layer. |
| 28 | Verbose output flooding context | Filter with native pipes first (grep/tail/head, Phase 3d-bis). Use RTK only if installed (`which rtk`). Rerun raw if the filter hides needed detail. |
| 29 | Inventing $ cost estimates | State tokens only (caps from Phase 3d). Never quote a model price the agent does not know. Use $ caps only from user-supplied budgets. |
| 30 | Swarmloop Mode without Pre-Flight confirmation | Phase 0.7a is a HARD GATE — never dispatch before the token estimate is confirmed by the user. |
| 31 | Critic grades a builder summary | Critic MUST inspect the real artifact (files, tests, renders) with fresh context — never the builder's history or summary. |
