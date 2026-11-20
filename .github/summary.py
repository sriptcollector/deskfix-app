# Task test summary: one table per run. Reads <OS>-<task>.log (the app's step log) and
# <OS>-<task>.json (the account's history rows from staging, which carry the AI cost).
import glob, json, os, re, sys

FIX = r"-(text|printer|broken|dark|pointer|sound|sleep|clock|scroll|wallpaper)$"
rows, ok, cost = [], 0, 0.0
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.log"))):
    name = os.path.basename(f)[:-4]
    log = open(f, errors="replace").read()
    m = re.search(r"DONE worked=(\w+) verified=(\w+)", log)
    # A fix counts only when it worked AND was verified; teach and chat count when they finished well.
    good = bool(m) and m.group(1) == "true" and (m.group(2) == "true" or not re.search(FIX, name))
    try:
        c = sum(float(h.get("cost", 0)) for h in json.load(open(f[:-4] + ".json")))
    except Exception:
        c = 0.0
    end = "solved" if good else "finished, not solved" if m else "problem" if "PROBLEM" in log else "stopped" if "STOPPED" in log else "no result"
    rows.append(f"| {name} | {end} | ${c:.3f} |")
    ok += good
    cost += c
n = len(rows)
print(f"Model setup: {os.environ.get('MODEL') or 'server default'}\n")
print(f"Success: {ok} of {n} ({100 * ok / max(1, n):.0f}%). AI cost: ${cost:.2f} total, ${cost / max(1, ok):.3f} per solved task.\n")
print("| Task | Result | AI cost |\n|---|---|---|\n" + "\n".join(rows))
