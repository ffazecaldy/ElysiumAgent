"""HumanEval benchmark with Elysium Swarmloop — Windows-compatible.
Usage: python humaneval_bench.py
Requires: human-eval cloned to C:\Users\Admin\human-eval
"""
import sys, subprocess, time, tempfile, os, re
sys.path.insert(0, r"C:\Users\Admin\human-eval")
from human_eval.data import read_problems

HERMES = r"C:\Users\Admin\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
SAMPLE_SIZE = 20
TIMEOUT = 300

def check_correctness(problem, completion, timeout=30):
    """Windows-compatible correctness check using subprocess."""
    code = problem["prompt"] + "\n" + completion + "\n" + problem["test"] + f"\ncheck({problem['entry_point']})"
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code); tp = f.name
        r = subprocess.run([sys.executable, tp], capture_output=True, text=True, timeout=timeout)
        os.unlink(tp)
        if r.returncode == 0:
            return {"task_id": problem["task_id"], "passed": True, "result": "passed"}
        return {"task_id": problem["task_id"], "passed": False, "result": f"failed: {r.stderr[:200]}"}
    except subprocess.TimeoutExpired:
        return {"task_id": problem["task_id"], "passed": False, "result": "timed out"}
    except Exception as e:
        return {"task_id": problem["task_id"], "passed": False, "result": f"failed: {str(e)[:200]}"}

def extract_code(text, entry_point):
    m = re.search(r"```python\s*\n(.*?)```", text, re.DOTALL)
    if m: return m.group(1)
    return text

def run(use_skill=True):
    problems = read_problems()
    task_ids = list(problems.keys())[:SAMPLE_SIZE]
    label = "WITH skill" if use_skill else "NO skill"
    print(f"HumanEval {SAMPLE_SIZE} tasks — {label}")
    
    passed = 0
    for i, tid in enumerate(task_ids):
        p = problems[tid]
        prompt = f"""Complete this Python function. Return ONLY the function code.

```python
{p['prompt']}
```

Function name: {p['entry_point']}
Return ONLY the Python code, no explanation."""

        start = time.time()
        cmd = [HERMES, "chat", "-q", prompt, "-Q"]
        if use_skill:
            cmd.insert(2, "--skills"); cmd.insert(3, "elysium-swarmloop")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
        elapsed = time.time() - start

        code = extract_code(r.stdout, p['entry_point'])
        result = check_correctness(p, code)
        if result["passed"]:
            passed += 1
            print(f"  [{i+1}/{SAMPLE_SIZE}] {tid} PASS | {elapsed:.0f}s")
        else:
            print(f"  [{i+1}/{SAMPLE_SIZE}] {tid} FAIL | {elapsed:.0f}s | {result['result'][:80]}")

    print(f"\n{'='*50}")
    print(f"  {label}: {passed}/{SAMPLE_SIZE} ({passed*100/SAMPLE_SIZE:.0f}%)")
    print(f"{'='*50}")

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--no-skill", action="store_true")
    args = p.parse_args()
    run(use_skill=not args.no_skill)
