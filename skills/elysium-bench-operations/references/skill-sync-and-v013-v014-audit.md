# Elysium-Swarmloop: Skill Sync + v0.13.x/v0.14.0 Audit (Aug 2026)

## Sync procedure: GitHub repo → Hermes skill dir (recurring task)

The Hermes-installed skill lives at:
`C:\Users\Admin\AppData\Local\hermes\skills\autonomous-ai-agents\elysium-swarmloop\`
The repo lives at `~/Elysium-Swarmloop` (remote `origin` = Boschi404/Elysium-Swarmloop; `ffazecaldy` remotes also exist — pull via origin).

Steps that work:

```bash
cd ~/Elysium-Swarmloop
git fetch origin && git log --oneline HEAD..origin/main   # what's new?
git stash push -u -m "local bench artifacts"              # repo ALWAYS has dirty state:
                                                          # humaneval_*.py, workspaces/, risultati/
git pull origin main
# then copy into the Hermes skill dir (KEEP the extra local references/*.md — they are NOT in the repo):
cp SKILL.md                          "$SK/SKILL.md"
cp references/pattern-store.sql      "$SK/references/pattern-store.sql"
cp scripts/e2e_test.py scripts/install.sh scripts/init-state.sh scripts/session_manager.py "$SK/scripts/"
# verify:
grep -m1 '^version:' "$SK/SKILL.md"
cd "$SK/scripts" && python e2e_test.py
```

Repo file set (v0.14.0): SKILL.md, README.md, references/pattern-store.sql, scripts/{e2e_test,install.sh,init-state.sh,session_manager.py}, assets/*, risultati/. Hermes skill dir additionally has local-only references (benchmark-*.md etc.) — never delete those during sync.

**Tag quirk:** tag `v0.12` points at the same commit as `v0.11.3` (652ce97) — a duplicate tag skipped in the changelog, not a real release.

## ⚠️ e2e_test.py "224/224 passed" is a FALSE verification for new features

Verified Aug 2026 (v0.14.0): the suite's header still says "v0.7.0", the report banner says "v0.10.0", and grepping for `swarmloop|allowlist|RTK|checkpoint|PR readiness|AGENTS.md|SPEC.md` returns ZERO matches. The 224 checks exercise only the v0.7.0-era core engine. Anything added in v0.13.x/v0.14.0 has NO automated coverage. Before trusting an e2e green on a new release, grep the test file for the new feature keywords.

## Audit of v0.13.0 → v0.14.0 (objective findings)

| Feature | Verdict | Evidence |
|---|---|---|
| v0.13.0 Document System (AGENTS/SPEC/ROADMAP/TASKS.md) | Marginal | 4 docs per task = ceremony; useful only for greenfield Tier 4 |
| v0.13.0 Approval Checkpoints (0.5a/0.5b) | Double-edged | Hard gate on every Tier 3+; conflicts with user's "action, not blocked tasks" preference; escape hatch is "fai tu" |
| v0.13.1 PR Readiness (3g-bis) | ~Zero for this user | User pushes direct to main, no CI/PR workflow |
| v0.13.2 Command Allowlist (3a check 5) | Redundant | Hermes approval system already blocks/warns dangerous commands; default-allow anyway |
| v0.13.2 RTK (3d-bis) | Dead weight | RTK not installed (needs cargo/Rust); wave dispatch + Hermes output truncation already cover it |
| v0.14.0 Swarmloop Mode (0.7) | Best idea, unverified | Builder/critic separation is sound (subagent isolation gives fresh-context critics natively); external concrete bar fixes the real "make it amazing" flaw |
| v0.14.0 cost gate (0.7a) | Weak | Agent doesn't know model per-token price → estimate gets invented, contradicting the skill's own anti-fabrication rules |
| v0.14.0 case-sensitive triggers | UX failure | `MAX EFFORT`/`SWARMLOOP MODE`/`MESM` exact-caps; pitfall #29 blames the user for typing lowercase; "MESM" is an arbitrary acronym; confusing taxonomy: lowercase `swarmloop` forces the loop but NOT the mode |

**Structural problems:** (1) zero test coverage for all post-v0.10.0 features; (2) ~half of the new content duplicates Hermes platform features (approval system, output truncation, subagent isolation); (3) none of the 4 releases targets the measured weaknesses (atomic-task overhead, SWE-bench patch applicability, scoring ceiling); (4) skill grows ~100 lines/release (1402 lines / 80KB) while preaching compression.

**Reusable audit technique for skill-improvement claims** (works for any skill, not just this one):
1. grep the project's own test suite for the new feature names → coverage or false-green?
2. Are referenced external tools actually installed on this machine?
3. Does the feature duplicate something the host platform already provides natively?
4. Do the changes target the MEASURED weaknesses (from benchmark history), or add ceremony?
5. Size trend vs the skill's own token-economy philosophy.

**Known measured weaknesses still unaddressed as of v0.14.0:** skill adds value ONLY on complex multi-file tasks (+18 pts Elysium-Bench), hurts or is neutral on atomic tasks (HumanEval 100% both ways, MBPP worse with skill), SWE-bench patches generate but don't apply (needs file-level context).
