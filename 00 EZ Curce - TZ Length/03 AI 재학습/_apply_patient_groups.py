#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""patient_groups.json의 환자 ID를 dataset-index에 주입한 사본을 만든다.

train_residual.py는 splitGrouping.minimumGroupId를 그룹 키로 쓴다. 원본은 그 값이
이미지 SHA-256이라 같은 환자의 교정 전/후가 train/test로 갈린다(384건 중 124건).
이 스크립트는 minimumGroupId를 환자 ID로 바꾼 사본을 써서, 원본을 건드리지 않고
누출 있는 평가 vs 없는 평가를 A/B로 비교할 수 있게 한다.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.json")
    parser.add_argument("--groups", type=Path, default=HERE / "patient_groups.json")
    parser.add_argument("--out", type=Path, default=HERE / "dataset-index.patientgrouped.json")
    args = parser.parse_args()

    index = json.loads(args.index.read_text(encoding="utf-8-sig"))
    groups = json.loads(args.groups.read_text(encoding="utf-8"))["assignments"]

    changed = 0
    missing = 0
    provenance: Counter[str] = Counter()
    for case in index["cases"]:
        info = groups.get(case["caseId"])
        if not info:
            missing += 1
            continue
        split = case.setdefault("splitGrouping", {})
        before = split.get("minimumGroupId")
        after = info["patientGroupId"]
        if before != after:
            changed += 1
        split["minimumGroupId"] = after
        split["minimumGroupProvenance"] = "patient_group_" + info["provenance"]
        split["patientGroupIds"] = [after]
        split["patientGroupProvenance"] = info["provenance"]
        split["prePatientGroupingId"] = before
        provenance[info["provenance"]] += 1

    index["schemaVersion"] = str(index.get("schemaVersion", "")) + "+patient-grouped"
    index["patientGroupingApplied"] = {
        "source": args.groups.name,
        "casesRewritten": changed,
        "casesMissingAssignment": missing,
        "provenance": dict(sorted(provenance.items())),
    }
    args.out.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(index["patientGroupingApplied"], ensure_ascii=False, indent=2))
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
