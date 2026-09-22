# Capability Campaign — Harness Only (Frozen Agent)

Real-task campaign against the **frozen** code at `c1d487c`. Agent/policy/system
prompts/types are untouched: this directory only ADDS fixtures, corpus and an
outer harness driving `runSwarmGoal` (the real runtime path: real planning
turn, real builders with the real bash gate, real critic, real evaluation →
learning → adaptive pipeline). Nothing is simulated; nothing was changed in the
agent to make tests pass.

## Run

```bash
pnpm exec tsx benchmarks/capability/run-campaign.ts              # baseline (mock provider)
pnpm exec tsx benchmarks/capability/run-campaign.ts --filter=T-A01,T-B02
pnpm exec tsx benchmarks/capability/run-campaign.ts --adaptive=apply --reps=5
pnpm exec tsx benchmarks/capability/run-campaign.ts --live        # z.ai GLM (provider from .env)
```

## Outputs

| Path | Content |
| ---- | ------- |
| `campaign-results.json` | One record per run (24 fields each) + summary block |
| `findings.json` | Findings log (P0–P3), filled during the campaign |
| `taskdefs.json` | Static view of the corpus (32 tasks + expected outcomes) |

## Structure

- `fixtures.ts` — 32 deterministic in-memory fixture repos (git-initialized)
- `taskdefs.ts` — corpus: 6 simple / 6 bugfix / 6 multi-file / 6 recovery / 4 ambiguous / 4 security
- `verify.ts` — static + runtime verifiers (node:test, subprocess, timeout)
- `runner.ts` — baseline + repetition executor, per-run record extraction
- `runner-adaptive.ts` — adaptive phase (gate audit, A/B probe, closed loop)
- `run-campaign.ts` — CLI entry, writes `campaign-results.json`

The agent is never modified by this campaign. Findings are classified, not fixed.
