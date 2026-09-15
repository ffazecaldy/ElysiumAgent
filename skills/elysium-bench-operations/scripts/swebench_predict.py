"""SWE-bench official prediction generator with Elysium Swarmloop.
Generates predictions.json for SWE-bench evaluation.

Usage:
    python swebench_predict.py          # 10 tasks, 600s timeout
    python swebench_predict.py --all    # all 300 tasks
    python swebench_predict.py --eval   # after predictions, run Docker eval

Requirements:
    pip install datasets swebench
    pip install click==8.1.7 --force-reinstall  # fix hermes after swebench install

Output:
    swebench_predictions.json  → SWE-bench format for run_evaluation
"""

import sys, subprocess, time, json, re, argparse
from pathlib import Path
from datasets import load_dataset

HERMES = r"C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
TIMEOUT = 600
OUTPUT = Path(__file__).parent.parent / "swebench_predictions.json"

def generate_predictions(n_tasks=10, timeout=TIMEOUT):
    ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
    instances = [ds[i] for i in range(min(n_tasks, len(ds)))]
    
    predictions = {}
    stats = {"total": 0, "patches": 0, "timeouts": 0, "errors": 0}
    
    for i, inst in enumerate(instances):
        task_id = inst["instance_id"]
        repo = inst["repo"]
        problem = inst["problem_statement"]
        stats["total"] += 1
        
        print(f"\n[{i+1}/{n_tasks}] {task_id} | {repo}", end=" ", flush=True)
        
        prompt = f"""You are an expert software engineer. Fix the following GitHub issue.

REPOSITORY: {repo}
ISSUE:
{problem}

INSTRUCTIONS:
1. Understand the issue and the codebase
2. Write the minimal code changes to fix the issue
3. Return ONLY the patch in unified diff format between ```diff and ``` markers
4. The patch must apply cleanly with `git apply`

Think step by step, then output your patch."""

        try:
            r = subprocess.run(
                [HERMES, "chat", "-q", prompt, "--skills", "elysium-swarmloop", "-Q"],
                capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired:
            stats["timeouts"] += 1
            print(f"⏰ TIMEOUT")
            continue
        
        output = r.stdout
        m = re.search(r"```diff\n(.*?)```", output, re.DOTALL)
        patch = m.group(1).strip() if m else ""
        
        if patch and "diff --git" in patch:
            stats["patches"] += 1
            predictions[task_id] = patch
            print(f"✅ {patch.count(chr(10))} lines, {len(patch)} chars")
        else:
            stats["errors"] += 1
            print(f"❌ No valid diff")
    
    submission = {
        "model_name": "Elysium-Swarmloop-v0.11.2",
        "model_patch": predictions,
        "total_instances": stats["total"],
    }
    OUTPUT.write_text(json.dumps(submission, indent=2))
    
    print(f"\n{'='*50}")
    print(f"  Patches: {stats['patches']}/{stats['total']} ({stats['patches']/max(1,stats['total'])*100:.0f}%)")
    print(f"  Timeouts: {stats['timeouts']} | Errors: {stats['errors']}")
    print(f"  Saved: {OUTPUT}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="All 300 tasks")
    parser.add_argument("--eval", action="store_true", help="Run Docker eval after predictions")
    parser.add_argument("--tasks", type=int, default=10)
    args = parser.parse_args()
    
    n = 300 if args.all else args.tasks
    generate_predictions(n)
    
    if args.eval:
        print("\nRunning SWE-bench evaluation (requires Docker)...")
        # SWE-bench eval: swebench.harness.run_evaluation
        subprocess.run([
            sys.executable, "-m", "swebench.harness.run_evaluation",
            "--dataset_name", "princeton-nlp/SWE-bench_Lite",
            "--predictions_path", str(OUTPUT),
            "--max_workers", "4",
            "--run_id", "elysium-v0112",
        ])
