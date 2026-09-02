"""
Turn every records.json under the evidence folder into the report tables:
status counts, per-phase evidence matrix, defect log (P0..P3), and the
list of Blocked / unverified journeys.

    python3 tests/e2e/live/build_report_tables.py > docs/evidence/live-acceptance-2026-09-02/TABLES.md
"""
import json
from collections import Counter
from pathlib import Path

EVIDENCE = Path(__file__).resolve().parents[3] / "docs" / "evidence" / "live-acceptance-2026-09-02"
SEV_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3, "-": 9, "": 9}


def load_all():
    out = []
    for p in sorted(EVIDENCE.glob("*/records.json")):
        try:
            for r in json.loads(p.read_text()):
                r["_phase_dir"] = p.parent.name
                out.append(r)
        except Exception as e:
            print(f"<!-- could not read {p}: {e} -->")
    return out


def cell(s, n=160):
    s = (s or "").replace("|", "\\|").replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    rs = load_all()
    counts = Counter(r.get("status", "?") for r in rs)
    print("## Status counts\n")
    print("| Status | Records |\n|---|---|")
    for k in ["Verified", "Failed", "Blocked", "Not implemented", "Intentionally disabled"]:
        print(f"| {k} | {counts.get(k, 0)} |")
    print(f"| **Total** | **{len(rs)}** |\n")

    print("## Defect log (Failed, by severity)\n")
    print("| Sev | Phase | Feature | What the customer sees | Repro | Evidence |\n|---|---|---|---|---|---|")
    failed = sorted((r for r in rs if r.get("status") == "Failed"), key=lambda r: (SEV_ORDER.get(r.get("severity", "-"), 9), r["_phase_dir"]))
    for r in failed:
        repro = "; ".join(r.get("repro") or r.get("actions") or [])
        print(f"| {r.get('severity','-')} | {r['_phase_dir']} | {cell(r['feature'], 70)} | {cell(r.get('actual'), 220)} | {cell(repro, 160)} | {cell(r.get('screenshot'), 90)} |")
    print()

    print("## Blocked and not implemented\n")
    print("| Status | Phase | Feature | Why | Evidence |\n|---|---|---|---|---|")
    for r in sorted((r for r in rs if r.get("status") in ("Blocked", "Not implemented", "Intentionally disabled")), key=lambda r: (r["status"], r["_phase_dir"])):
        print(f"| {r['status']} | {r['_phase_dir']} | {cell(r['feature'], 70)} | {cell(r.get('actual'), 220)} | {cell(r.get('screenshot'), 90)} |")
    print()

    print("## Full evidence matrix\n")
    for phase in sorted({r["_phase_dir"] for r in rs}):
        sub = [r for r in rs if r["_phase_dir"] == phase]
        c = Counter(r.get("status") for r in sub)
        print(f"### {phase} — " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())) + "\n")
        print("| Feature | Status | Sev | Actual | Persistence | Console errs | 4xx/5xx | Screenshot |\n|---|---|---|---|---|---|---|---|")
        for r in sub:
            errs = len(r.get("console_errors") or [])
            bad = sum(1 for n in (r.get("network") or []) if isinstance(n.get("status"), int) and n["status"] >= 400)
            print(f"| {cell(r['feature'], 70)} | {r.get('status')} | {r.get('severity','-')} | {cell(r.get('actual'), 200)} | {cell(r.get('persistence'), 40)} | {errs} | {bad} | {cell(r.get('screenshot'), 80)} |")
        print()


if __name__ == "__main__":
    main()
