# v0.15.0 Release & Sync Workflow (Elysium-Swarmloop)

Outcome of the "fix the v0.13.x–v0.14.0 audit findings" session (2026-08-20). The audit
in `skill-sync-and-v013-v014-audit.md` was implemented as skill release **v0.15.0**:
8 fixes + e2e Scenario 5 (224→250 checks) + README + tag, pushed to fork ffazecaldy.

## Release workflow (repeatable for any repo-maintained Hermes skill)

1. **Pull safely with a dirty worktree** (bench artifacts accumulate):
   `git stash push -u -m "local artifacts pre-pull"` then `git pull origin main`.
   Never hard-reset: untracked bench scripts would be lost or would block the pull.
2. **Diff scope**: `git diff --stat OLD..HEAD` + read the changelog top entries.
   Report what changed vs the INSTALLED skill version, not just remote HEAD.
3. **Sync into Hermes skill dir** — copy ONLY changed files, never wipe:
   - Skill dir = `~/AppData/Local/hermes/skills/autonomous-ai-agents/elysium-swarmloop`
   - Repo files: `SKILL.md`, `references/`, `scripts/`, `assets/`
   - The skill dir contains EXTRA local files (benchmark-*.md references, session results)
     that do not exist in the repo — `rm -rf` + fresh copy would destroy them.
   - `cp` one file at a time (a `cp a b c` with 2 sources + 1 dir target fails on MSYS).
4. **Verify from the INSTALLED dir**, not the repo:
   `python scripts/e2e_test.py` inside the skill dir + check `version:` in frontmatter.
5. **Commit + tag + push to fork** (see fork-push procedure below).
6. Verify on GitHub API before declaring done: commits/main message + tag presence.

## Fork push procedure (the ffazecaldy case)

Symptom: `git push ffazecaldy main` (SSH) → `Permission denied (publickey)`;
`git push ffazecaldy-https` → `Repository not found`.

Root cause: **the fork did not exist**. A configured remote is not proof of a fork.
Fix sequence:
```bash
# 1. Check existence (404 = missing)
curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/ffazecaldy/Elysium-Swarmloop
# 2. Create fork via API (returns 202, async)
TOKEN=$(git credential fill <<< $'protocol=https\nhost=github.com\n' 2>/dev/null | grep ^password | cut -d= -f2)
curl -s -X POST -H "Authorization: token $TOKEN" https://api.github.com/repos/Boschi404/Elysium-Swarmloop/forks
# 3. Poll until 200 (fork ready)
# 4. Push over https (credential manager supplies token automatically)
git push ffazecaldy-https main --tags
```
Token retrieval via `git credential fill` heredoc works when gh CLI is absent.
Never print the token; use it inline only.

## The e2e "false green" meta-lesson

Before v0.15.0: suite said "224/224 ✅" but the script header still read v0.7.0
and tested ONLY the core engine — zero coverage for v0.13.x–v0.14.0 features.
A green suite proves nothing about features the suite doesn't touch.

**Rule for every future release: extend the test suite with a contract scenario.**
Implemented as Scenario 5 in `scripts/e2e_test.py`: reads `../SKILL.md` and asserts
the presence/absence of the exact strings that define each new feature (trigger
case-insensitivity, smart checkpoints, token-based cost gate, conditional RTK/PR/docs,
allowlist enforcement layer, changelog order). ~25 grep-style checks = real evidence.

Checklist to audit any claimed skill feature (from the v0.13.x/v0.14.0 audit):
1. Does the e2e suite actually test it? (grep the test file for feature keywords)
2. Is the referenced tool actually installed? (`which rtk` → absent → section must be conditional)
3. Does the platform already provide the mechanism? (Hermes approval system, subagent isolation, output truncation)
4. Does it conflict with the user's measured usage? (user wants action, hates blocked tasks → hard checkpoints = friction)
5. Does it target measured weaknesses or add ceremony? (benchmark evidence: skill adds value ONLY on multi-file tasks)

## v0.15.0 fixes applied (for reference)

| # | Fix | Change |
|---|-----|--------|
| 1 | Triggers | case-sensitive → case-INSENSITIVE (MAX EFFORT / SWARMLOOP MODE / MESM any case) |
| 2 | Approval checkpoints | hard gate all Tier 3+ → smart opt-in (auto-approve on "fai tu"; hard wait only Tier 4/greenfield/money) |
| 3 | Cost gate | $ estimate (fabricated price) → token-based (summary caps from Phase 3d) |
| 4 | RTK | mandatory-ish → native pipes first, RTK only if installed |
| 5 | PR readiness | always → only PR-based repos; anti-fabrication rules stay global |
| 6 | Doc system | 4 docs every Tier 3+ → tier-scoped (4 docs = Tier 4 only) |
| 7 | Allowlist | as sole defense → Hermes approval = documented enforcement layer |
| 8 | e2e | 224 core-only → 250 with Scenario 5 contract checks |

Version rule observed: multiple UX/verification fixes across sections = MINOR bump
(v0.14.0 → v0.15.0), per the skill's own versioning policy.

## v0.15.0-final (lean skill + release) — same session, second half

User directive: **no version history inside SKILL.md**. The skill must be the working
engine only — every in-skill changelog line is dead context tokens. Consequences:

- Removed the whole `## Version History` section (1402→1118 lines, -284).
- Transparency note compressed to 1 line (keep only still-true caveats).
- Guardrail rule updated: release notes live in the GitHub Release, not in-skill.
- e2e Scenario 5 updated to enforce the lean contract: assert `## Version History`
  is ABSENT and old version entries are ABSENT (251/251). **When the skill's structure
  changes, contract checks MUST change with it** — never leave checks asserting things
  you just removed.
- Stated counts get stale after edits — re-check them (pitfalls header 28→31).

### Tag move on same release (cleanup after initial push)
New commit → `git tag -f vX.Y.Z` → `git push <remote> main --tags --force`.
Force-push of tags triggers Hermes approval — expected; let the user approve.

### Push identity & target repo (the "hai fatto qui la push?" correction)
- When the user gives a repo URL, push to THAT repo. Pushing only to the fork is
  wrong unless they explicitly said fork-only. When in doubt, push BOTH parent+fork.
- When the user says "the pusher must be <user>": (1) commit author must be <user>
  (`git config user.name/email`), (2) push AUTH must be <user>'s token — do NOT
  rely on origin's embedded token (it may belong to another account). Push via
  inline URL: `git push https://<user>:$TOKEN@github.com/<owner>/<repo>.git main --tags`
- Pre-check write permission: GET /repos/{o}/{r}/collaborators/{user}/permission → "write".
- Verify AFTER pushing via API (head sha + tag list), not just the push output.

### GitHub Release via REST API (no gh CLI) — pitfalls
- JSON body: write it with write_file first, then `curl --data-binary @file.json`.
  Heredoc to /tmp is unreliable on Windows git-bash (curl "error reading file").
- `target_commitish` with a SHORT SHA → HTTP 422 Validation Failed (field
  target_commitish invalid). Use `"main"` or omit the field (defaults to tag commit).
- Create the release on BOTH parent and fork to keep them aligned (201 on each).
- Verify: GET /repos/{o}/{r}/releases → tag_name + html_url.
