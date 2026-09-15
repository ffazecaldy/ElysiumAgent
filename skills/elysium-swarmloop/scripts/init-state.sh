#!/usr/bin/env bash
# ============================================================================
# init-state.sh — Elysium Swarmloop Bootloader  v0.7.0
#
# Initialises the STATE object for the autonomous multi-agent orchestration
# engine.  Idempotent: re-run with the same GOAL to update state mid-loop.
#
# Usage:
#   ./init-state.sh                              # auto-detect goal from context
#   ./init-state.sh "Build a REST API"           # explicit goal
#   ./init-state.sh --json "Build a REST API"    # raw JSON output only
#   ./init-state.sh --clarify                    # output clarification questions
#   ./init-state.sh --quality-first              # strict quality mode
#   ./init-state.sh --plan-file /tmp/plan.md     # write plan to file
#   ./init-state.sh --structural-scan ./src      # detect project conventions
# ============================================================================
set -euo pipefail

# ---- constants ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${STATE_FILE:-${SCRIPT_DIR}/../.state.json}"
DEFAULT_SUBAGENTS=100
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION="v0.7.0"

# ---- helpers -----------------------------------------------------------

# Print a usage message and exit.
usage() {
  cat <<EOF
Usage: $(basename "$0") [options] [<goal>]

Options:
  --json                    Print raw JSON state to stdout (no side-effects).
  --clarify                 Output clarification questions as JSON and exit.
  --quality-first           Override threshold to 9/10, max_iterations to 9,
                            enable global_recheck.
  --plan-file <path>        Write decomposition plan to the specified file path.
  --structural-scan <path>  Scan existing project structure and output
                            conventions found.
  -h, --help                Show this message.

If <goal> is omitted the script tries to auto-detect it from the working
directory name or an existing STATE_FILE.
EOF
  exit 0
}

# ---- clarification questions -------------------------------------------

# Print a JSON array of 5-6 clarification questions about the project.
print_clarify_json() {
  local goal="${1:-unknown}"
  cat <<EOJSON
{
  "version": "$VERSION",
  "mode": "clarify",
  "goal": $(echo "$goal" | jq -Rs .),
  "questions": [
    {
      "id": "db",
      "question": "Which database do you plan to use? (e.g., PostgreSQL, SQLite, MongoDB, none)",
      "category": "database"
    },
    {
      "id": "frontend",
      "question": "Do you need a frontend UI? If so, which framework? (e.g., React, Vue, plain HTML, none)",
      "category": "frontend"
    },
    {
      "id": "auth",
      "question": "What authentication / authorisation mechanism is required? (e.g., JWT, OAuth, session-based, none)",
      "category": "authentication"
    },
    {
      "id": "deploy",
      "question": "Where will this be deployed? (e.g., localhost, Docker, Vercel, cloud VM, Kubernetes)",
      "category": "deployment"
    },
    {
      "id": "scope",
      "question": "What is the scope of this task? (e.g., MVP / proof-of-concept / production-grade / legacy migration)",
      "category": "scope"
    },
    {
      "id": "testing",
      "question": "What is the expected testing strategy? (e.g., pytest, unit tests, integration tests, TDD, none yet)",
      "category": "testing"
    }
  ],
  "user_preferences": {
    "language": "italiano",
    "auto_commit": true,
    "auto_push": true,
    "test_command": "pytest -q"
  }
}
EOJSON
}

# ---- structural scan ---------------------------------------------------

# Scan a project directory for known structural conventions and output a
# JSON summary of what was found.
structural_scan() {
  local scan_path="$1"

  if [[ ! -d "$scan_path" ]]; then
    echo '{"error": "Path not found or not a directory", "path": '$(echo "$scan_path" | jq -Rs .)'}' >&2
    return 1
  fi

  local conventions="{}"
  local has_docker=false
  local has_ci=false
  local has_tests=false
  local has_readme=false
  local has_package=false
  local has_makefile=false
  local has_compose=false
  local has_env=false
  local has_lint=false
  local pkg_manager="unknown"

  # Detect Docker / containerisation
  if [[ -f "${scan_path}/Dockerfile" ]]; then has_docker=true; fi
  if [[ -f "${scan_path}/docker-compose.yml" ]] || [[ -f "${scan_path}/docker-compose.yaml" ]]; then has_compose=true; fi

  # Detect CI config
  if [[ -d "${scan_path}/.github/workflows" ]] || [[ -f "${scan_path}/.gitlab-ci.yml" ]] || [[ -f "${scan_path}/Jenkinsfile" ]]; then has_ci=true; fi

  # Detect test directories
  if [[ -d "${scan_path}/tests" ]] || [[ -d "${scan_path}/test" ]] || [[ -d "${scan_path}/__tests__" ]] || [[ -d "${scan_path}/spec" ]]; then has_tests=true; fi

  # Detect documentation
  if [[ -f "${scan_path}/README.md" ]] || [[ -f "${scan_path}/README.rst" ]] || [[ -f "${scan_path}/README.txt" ]]; then has_readme=true; fi

  # Detect package manager
  if [[ -f "${scan_path}/package.json" ]]; then pkg_manager="npm"; fi
  if [[ -f "${scan_path}/yarn.lock" ]]; then pkg_manager="yarn"; fi
  if [[ -f "${scan_path}/pnpm-lock.yaml" ]]; then pkg_manager="pnpm"; fi
  if [[ -f "${scan_path}/Cargo.toml" ]]; then pkg_manager="cargo"; fi
  if [[ -f "${scan_path}/go.mod" ]]; then pkg_manager="go"; fi
  if [[ -f "${scan_path}/requirements.txt" ]] || [[ -f "${scan_path}/pyproject.toml" ]] || [[ -f "${scan_path}/setup.py" ]]; then pkg_manager="pip"; fi
  if [[ -f "${scan_path}/Gemfile" ]]; then pkg_manager="bundler"; fi

  # Detect Makefile / task runner
  if [[ -f "${scan_path}/Makefile" ]]; then has_makefile=true; fi

  # Detect .env files
  if ls "${scan_path}"/.env* 1>/dev/null 2>&1; then has_env=true; fi

  # Detect linter config
  if [[ -f "${scan_path}/.eslintrc"* ]] || [[ -f "${scan_path}/.prettierrc"* ]] || [[ -f "${scan_path}/.golangci.yml" ]] || [[ -f "${scan_path}/.flake8" ]] || [[ -f "${scan_path}/ruff.toml" ]]; then has_lint=true; fi

  # Detect Python project
  local is_python=false
  if [[ -f "${scan_path}/requirements.txt" ]] || [[ -f "${scan_path}/pyproject.toml" ]] || [[ -f "${scan_path}/setup.py" ]] || [[ -f "${scan_path}/setup.cfg" ]] || [[ -f "${scan_path}/Pipfile" ]]; then is_python=true; fi

  # Detect Node project
  local is_node=false
  if [[ -f "${scan_path}/package.json" ]]; then is_node=true; fi

  # Detect Go project
  local is_go=false
  if [[ -f "${scan_path}/go.mod" ]]; then is_go=true; fi

  # Detect Rust project
  local is_rust=false
  if [[ -f "${scan_path}/Cargo.toml" ]]; then is_rust=true; fi

  # Detect directory conventions
  local has_src_dir=false
  if [[ -d "${scan_path}/src" ]]; then has_src_dir=true; fi

  local has_lib_dir=false
  if [[ -d "${scan_path}/lib" ]]; then has_lib_dir=true; fi

  local has_bin_dir=false
  if [[ -d "${scan_path}/bin" ]] || [[ -d "${scan_path}/scripts" ]]; then has_bin_dir=true; fi

  local has_config_dir=false
  if [[ -d "${scan_path}/config" ]]; then has_config_dir=true; fi

  # Build output JSON
  cat <<EOJSON
{
  "version": "$VERSION",
  "mode": "structural_scan",
  "path": $(echo "$scan_path" | jq -Rs .),
  "project_type": {
    "python": $is_python,
    "node": $is_node,
    "go": $is_go,
    "rust": $is_rust
  },
  "package_manager": $(echo "$pkg_manager" | jq -Rs .),
  "conventions": {
    "has_docker": $has_docker,
    "has_docker_compose": $has_compose,
    "has_ci": $has_ci,
    "has_tests": $has_tests,
    "has_readme": $has_readme,
    "has_makefile": $has_makefile,
    "has_env_file": $has_env,
    "has_linter_config": $has_lint,
    "has_src_directory": $has_src_dir,
    "has_lib_directory": $has_lib_dir,
    "has_bin_or_scripts_directory": $has_bin_dir,
    "has_config_directory": $has_config_dir
  },
  "recommended_test_command": $(if $is_python; then echo '"pytest -q"'; elif $is_node; then echo '"npm test"'; elif $is_go; then echo '"go test ./..."'; elif $is_rust; then echo '"cargo test"'; else echo '""'; fi),
  "recommended_language": $(if $is_python; then echo '"python"'; elif $is_node; then echo '"javascript"'; elif $is_go; then echo '"go"'; elif $is_rust; then echo '"rust"'; else echo '"unknown"'; fi)
}
EOJSON
}

# ---- tier detection ----------------------------------------------------

# Auto-detect the execution tier based on task complexity keywords found in
# the goal string.  Uses a simple keyword-scoring heuristic.
#
# Returns: tier_number (1-4)
detect_tier() {
  local goal="$*"
  local score=0

  # Tier-1 signals (quick / trivial)
  if echo "$goal" | grep -qiE '\b(quick|tiny|minor|typo|config\s*change|edit|single\s*command|bump\s*version|rename)\b'; then
    score=1
  fi

  # Tier-2 signals (small feature / bugfix)
  if echo "$goal" | grep -qiE '\b(bugfix|bug\s*fix|feature|refactor|modular|test\s*add|small|update|patch|add\s*endpoint)\b'; then
    score=$(( score > 2 ? score : 2 ))
  fi

  # Tier-3 signals (multi-file / research)
  if echo "$goal" | grep -qiE '\b(api|research|migration|multi.?file|dashboard|integration|pipeline|service|module|component)\b'; then
    score=$(( score > 3 ? score : 3 ))
  fi

  # Tier-4 signals (greenfield / redesign)
  if echo "$goal" | grep -qiE '\b(greenfield|from\s*scratch|full.?stack|system|platform|redesign|rewrite|architecture|mvp|production)\b'; then
    score=$(( score > 4 ? score : 4 ))
  fi

  # Clamp 1-4
  if [[ $score -lt 1 ]]; then
    echo 1
  elif [[ $score -gt 4 ]]; then
    echo 4
  else
    echo "$score"
  fi
}

# Return the recommended subagent count for the given tier.
tier_to_subagents() {
  local tier="$1"
  case "$tier" in
    1) echo 3  ;;
    2) echo 10 ;;
    3) echo 35 ;;
    4) echo 80 ;;
    *) echo "$DEFAULT_SUBAGENTS" ;;
  esac
}

# Return the quality threshold (out of 10) for the given tier.
tier_to_threshold() {
  local tier="$1"
  case "$tier" in
    1) echo 6 ;;
    2) echo 7 ;;
    3) echo 7 ;;
    4) echo 8 ;;
    *) echo 7 ;;
  esac
}

# ---- state helpers -----------------------------------------------------

# Print the current state as a JSON object.
# Arguments: goal, tier, subagents, threshold, iteration, completed, failed,
#            in_flight, start_time, quality_first, clarify_mode, plan_file,
#            global_recheck, max_iterations
build_state_json() {
  local goal="$1"
  local tier="$2"
  local subagents="$3"
  local threshold="$4"
  local iteration="$5"
  local completed="$6"
  local failed="$7"
  local in_flight="$8"
  local start_time="$9"
  local quality_first="${10}"
  local clarify_mode="${11}"
  local plan_file="${12}"
  local global_recheck="${13}"
  local max_iterations="${14}"

  cat <<EOJSON
{
  "goal": $(echo "$goal" | jq -Rs .),
  "tier": $tier,
  "subagents": $subagents,
  "threshold": $threshold,
  "iteration": $iteration,
  "completed": $completed,
  "failed": $failed,
  "in_flight": $in_flight,
  "start_time": $(echo "$start_time" | jq -Rs .),
  "quality_first": $quality_first,
  "clarify_mode": $clarify_mode,
  "plan_file": $(echo "$plan_file" | jq -Rs .),
  "global_recheck": $global_recheck,
  "max_iterations": $max_iterations,
  "version": "$VERSION",
  "user_preferences": {
    "language": "italiano",
    "auto_commit": true,
    "auto_push": true,
    "test_command": "pytest -q"
  }
}
EOJSON
}

# Persist state JSON to STATE_FILE.
write_state() {
  echo "$1" > "$STATE_FILE"
  echo "[init-state] State written to $STATE_FILE" >&2
}

# Load state from STATE_FILE (if it exists) and source into environment.
# Prints JSON to stdout.
load_state() {
  if [[ -f "$STATE_FILE" ]]; then
    cat "$STATE_FILE"
  else
    echo "{}"
  fi
}

# ---- assessment & decision helpers -------------------------------------

# Analyse current state and print a human-readable assessment.
# Reads state JSON from stdin.
assess_state() {
  local state
  state="$(cat)"

  local goal tier subagents threshold iteration completed failed in_flight
  goal="$(echo "$state" | jq -r '.goal // "unknown"')"
  tier="$(echo "$state" | jq -r '.tier // 1')"
  subagents="$(echo "$state" | jq -r '.subagents // 0')"
  threshold="$(echo "$state" | jq -r '.threshold // 6')"
  iteration="$(echo "$state" | jq -r '.iteration // 0')"
  completed="$(echo "$state" | jq -r '.completed // 0')"
  failed="$(echo "$state" | jq -r '.failed // 0')"
  in_flight="$(echo "$state" | jq -r '.in_flight // 0')"

  local total=$(( completed + failed + in_flight ))
  local pct=0
  if [[ $total -gt 0 ]]; then
    pct=$(( completed * 100 / total ))
  fi

  cat <<EOASSESS
═══ Elysium Swarmloop — State Assessment ═══
Goal:       ${goal}
Tier:       ${tier} (${subagents} subagents, threshold ${threshold}/10)
Iteration:  ${iteration}
Progress:   ${completed} done, ${failed} failed, ${in_flight} in flight
Pass rate:  ${pct}%
Status:     $( [[ $in_flight -gt 0 ]] && echo "IN FLIGHT — streaming" || [[ $failed -gt 0 ]] && echo "RETRY NEEDED" || [[ $completed -gt 0 ]] && echo "IDLE — check completion" || echo "NOT STARTED" )
══════════════════════════════════════════════
EOASSESS
}

# Based on current state, print the recommended next action.
# Reads state JSON from stdin.
decide_action() {
  local state
  state="$(cat)"

  local completed failed in_flight iteration max_iter
  completed="$(echo "$state" | jq -r '.completed // 0')"
  failed="$(echo "$state" | jq -r '.failed // 0')"
  in_flight="$(echo "$state" | jq -r '.in_flight // 0')"
  iteration="$(echo "$state" | jq -r '.iteration // 0')"
  max_iter="$(echo "$state" | jq -r '.max_iterations // 10')"

  if [[ $in_flight -gt 0 ]]; then
    echo '{"action": "stream", "reason": "Results in flight — wait and process streaming"}'
  elif [[ $failed -gt 0 ]] && [[ $iteration -lt $max_iter ]]; then
    echo '{"action": "retry", "reason": "Failed tasks exist — retry with enriched feedback"}'
  elif [[ $failed -gt 0 ]] && [[ $iteration -ge $max_iter ]]; then
    echo '{"action": "escalate", "reason": "Max iterations reached — escalate to user"}'
  elif [[ $completed -eq 0 ]] && [[ $in_flight -eq 0 ]]; then
    echo '{"action": "decompose", "reason": "Not started — decompose goal and dispatch"}'
  elif [[ $in_flight -eq 0 ]] && [[ $failed -eq 0 ]] && [[ $completed -gt 0 ]]; then
    echo '{"action": "complete", "reason": "All tasks accounted for — submit final report"}'
  else
    echo '{"action": "assess", "reason": "Ambiguous state — re-assess before deciding"}'
  fi
}

# Print the full state object in a human-friendly table.
# Reads state JSON from stdin.
print_state() {
  local state
  state="$(cat)"

  echo "$state" | jq -r '
    "╔══════════════════════════════════════╗",
    "║     Elysium Swarmloop — State        ║",
    "╠══════════════════════════════════════╣",
    "║ Goal:       " + (.goal // "—" | .[0:50]),
    "║ Tier:       " + (.tier | tostring) + "  (" + (.subagents | tostring) + " sub, threshold " + (.threshold | tostring) + "/10)",
    "║ Iteration:  " + (.iteration | tostring),
    "║ Completed:  " + (.completed | tostring),
    "║ Failed:     " + (.failed | tostring),
    "║ In flight:  " + (.in_flight | tostring),
    "║ Started:    " + (.start_time // "—"),
    "║ Quality 1st:" + (.quality_first | tostring),
    "║ Clarify:    " + (.clarify_mode | tostring),
    "║ Plan file:  " + (.plan_file // "—"),
    "║ Recheck:    " + (.global_recheck | tostring),
    "║ Max iters:  " + (.max_iterations // "10" | tostring),
    "╚══════════════════════════════════════╝"
  '
}

# ---- plan file writer ---------------------------------------------------

# Write a decomposition plan skeleton to the specified file path.
write_plan_file() {
  local plan_path="$1"
  local goal="$2"
  local tier="$3"

  local plan_dir
  plan_dir="$(dirname "$plan_path")"

  if [[ ! -d "$plan_dir" ]]; then
    mkdir -p "$plan_dir" 2>/dev/null || {
      echo "[init-state] Warning: could not create directory for plan file: $plan_dir" >&2
    }
  fi

  cat > "$plan_path" <<EOPLAN
# Elysium Swarmloop — Decomposition Plan
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Goal: ${goal}
# Tier: ${tier}

## Overview

Decomposition plan for: **${goal}**

## Tasks

1. TBD — Analyse requirements
2. TBD — Design architecture
3. TBD — Implement core logic
4. TBD — Write tests
5. TBD — Document and deploy

---

*This plan was auto-generated by init-state.sh ${VERSION}. Update each task as the*
*orchestrator decomposes the goal into actionable work items.*
EOPLAN

  echo "[init-state] Plan skeleton written to ${plan_path}" >&2
}

# ---- main --------------------------------------------------------------

main() {
  local json_only=false
  local clarify_mode=false
  local quality_first=false
  local plan_file=""
  local scan_path=""
  local goal=""

  # Parse options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)              json_only=true;   shift ;;
      --clarify)           clarify_mode=true; shift ;;
      --quality-first)     quality_first=true; shift ;;
      --plan-file)         plan_file="$2";    shift 2 ;;
      --structural-scan)   scan_path="$2";    shift 2 ;;
      -h|--help)           usage ;;
      *)                   goal="$*";         break ;;
    esac
  done

  # --- Clarify mode: print questions and exit ---------------------------
  if $clarify_mode; then
    # Auto-detect goal for context in questions
    if [[ -z "$goal" ]]; then
      if [[ -f "$STATE_FILE" ]]; then
        goal="$(jq -r '.goal // empty' "$STATE_FILE" 2>/dev/null || true)"
      fi
      if [[ -z "$goal" ]]; then
        goal="$(basename "$(pwd)")"
      fi
    fi
    print_clarify_json "$goal"
    exit 0
  fi

  # --- Structural scan mode: scan path and exit -------------------------
  if [[ -n "$scan_path" ]]; then
    structural_scan "$scan_path"
    exit $?
  fi

  # --- Normal initialisation mode ---------------------------------------

  # Auto-detect goal if not provided
  if [[ -z "$goal" ]]; then
    if [[ -f "$STATE_FILE" ]]; then
      goal="$(jq -r '.goal // empty' "$STATE_FILE" 2>/dev/null || true)"
    fi
    if [[ -z "$goal" ]]; then
      goal="$(basename "$(pwd)")"
    fi
  fi

  # Determine / increment state ------------------------------------------
  local existing_state
  existing_state="$(load_state)"

  local tier subagents threshold iteration completed failed in_flight start_time
  local quality_first_state=false
  local clarify_mode_state=false
  local plan_file_state=""
  local global_recheck=false
  local max_iterations=10

  # Idempotent: if a state file exists AND goal matches, carry values forward
  local existing_goal
  existing_goal="$(echo "$existing_state" | jq -r '.goal // ""')"

  if [[ "$existing_goal" == "$goal" ]] && [[ "$existing_goal" != "" ]]; then
    # Re-use existing counters (idempotent update)
    tier="$(echo "$existing_state" | jq -r '.tier // 1')"
    subagents="$(echo "$existing_state" | jq -r '.subagents // 0')"
    threshold="$(echo "$existing_state" | jq -r '.threshold // 6')"
    iteration="$(echo "$existing_state" | jq -r '.iteration // 0')"
    completed="$(echo "$existing_state" | jq -r '.completed // 0')"
    failed="$(echo "$existing_state" | jq -r '.failed // 0')"
    in_flight="$(echo "$existing_state" | jq -r '.in_flight // 0')"
    start_time="$(echo "$existing_state" | jq -r '.start_time // ""')"
    quality_first_state="$(echo "$existing_state" | jq -r '.quality_first // false')"
    clarify_mode_state="$(echo "$existing_state" | jq -r '.clarify_mode // false')"
    plan_file_state="$(echo "$existing_state" | jq -r '.plan_file // ""')"
    global_recheck="$(echo "$existing_state" | jq -r '.global_recheck // false')"
    max_iterations="$(echo "$existing_state" | jq -r '.max_iterations // 10')"
  else
    # Fresh initialisation
    tier="$(detect_tier "$goal")"
    subagents="$(tier_to_subagents "$tier")"
    threshold="$(tier_to_threshold "$tier")"
    iteration=0
    completed=0
    failed=0
    in_flight=0
    start_time="$START_TIME"
  fi

  # Apply --quality-first overrides (these always win)
  if $quality_first; then
    threshold=9
    max_iterations=9
    global_recheck=true
    quality_first_state=true
  fi

  # Apply --plan-file (always wins over persisted value)
  if [[ -n "$plan_file" ]]; then
    plan_file_state="$plan_file"
  fi

  # Build state JSON -----------------------------------------------------
  local state_json
  state_json="$(build_state_json \
    "$goal" "$tier" "$subagents" "$threshold" \
    "$iteration" "$completed" "$failed" "$in_flight" "$start_time" \
    "$quality_first_state" "$clarify_mode_state" "$plan_file_state" \
    "$global_recheck" "$max_iterations")"

  # Write plan file if requested -----------------------------------------
  if [[ -n "$plan_file_state" ]]; then
    write_plan_file "$plan_file_state" "$goal" "$tier"
  fi

  # Output ---------------------------------------------------------------
  if $json_only; then
    echo "$state_json"
  else
    write_state "$state_json"
    echo "$state_json" | print_state
    echo ""
    echo "$state_json" | assess_state
    echo ""
    echo "Recommended action:"
    echo "$state_json" | decide_action
  fi
}

main "$@"
