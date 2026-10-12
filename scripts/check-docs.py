#!/usr/bin/env python3
"""Check the docs the way CI does: python3 scripts/check-docs.py  (exit 1 on any problem).

1. Every spec's "Before you build" box is current (scripts/docs-context.py --check).
2. No broken relative links in docs/ or AGENTS.md.
3. Acceptance-criterion IDs are unique, and every reference names an existing criterion.
4. Every criterion (except struck-through ones) is in exactly one task's "Done when" line.
5. Every task's dependencies exist, and its "Read" links resolve to real sections (scripts/next.py).
"""
import collections
import glob
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(ROOT)
problems = []

r = subprocess.run([sys.executable, "scripts/docs-context.py", "--check"], capture_output=True, text=True)
if r.returncode:
    problems.append(r.stdout.strip())

md = glob.glob("docs/**/*.md", recursive=True) + ["AGENTS.md"]
for p in md:
    text = open(p, encoding="utf-8").read()
    text = re.sub(r"```.*?```", "", text, flags=re.S)          # ignore code blocks
    for m in re.finditer(r"\]\(([^)#\s]+)(#[^)]*)?\)", text):
        target = m.group(1)
        if re.match(r"[a-z]+:", target):
            continue
        if not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(p), target))):
            problems.append(f"broken link in {p}: {target}")

defined = collections.Counter()
struck = set(re.findall(r"~~\*\*(AC-[A-Z]+-\d+)\*\*~~", "".join(open(p, encoding="utf-8").read() for p in md)))
referenced = set()
for p in md:
    text = open(p, encoding="utf-8").read()
    for m in re.finditer(r"(?<!~~)\*\*(AC-[A-Z]+-\d+)\*\*", text):
        defined[m.group(1)] += 1
    referenced |= set(re.findall(r"AC-[A-Z]+-\d+", text))
problems += [f"criterion defined twice: {a}" for a, n in defined.items() if n > 1]
problems += [f"unknown criterion referenced: {a}" for a in sorted(referenced - set(defined) - struck)]

placed = collections.Counter()
task_ids, deps = set(), []
for p in sorted(glob.glob("docs/plan/tasks/M*.md")):
    text = open(p, encoding="utf-8").read()
    task_ids |= set(re.findall(r"^### (M\d+-\d+\w*)", text, re.M))
    for line in text.splitlines():
        if line.startswith("- **Done when:**"):
            for a in set(re.findall(r"AC-[A-Z]+-\d+", line)):
                placed[a] += 1
        if line.startswith("- **Depends on:**"):
            deps += re.findall(r"M\d+-\d+\w*", line)
problems += [f"criterion in no task: {a}" for a in sorted(set(defined) - struck - set(placed))]
problems += [f"criterion in several tasks: {a}" for a, n in placed.items() if n > 1]
problems += [f"unknown task in Depends on: {d}" for d in sorted(set(deps) - task_ids)]

for tid in sorted(task_ids):
    out = subprocess.run([sys.executable, "scripts/next.py", tid], capture_output=True, text=True).stdout
    if "Couldn't find those sections" in out:
        problems.append(f"task {tid}: a Read link names a section that doesn't exist")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"docs OK: {len(defined)} criteria, {len(task_ids)} tasks, links and boxes current")
