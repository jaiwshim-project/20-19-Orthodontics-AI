#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""환자 단위 그룹 ID 생성 (누출 차단용).

## 왜 필요한가
dataset-index.json의 splitGrouping.patientGroupIds가 비어 있다
(patientGroupProvenance = "not_generated_missing_private_salt"). 그래서 현재
그룹 키는 이미지 SHA-256뿐이다. 그런데 같은 환자의 교정 전 사진과 교정 후
사진은 SHA가 다르므로 train/test로 갈릴 수 있다 = 누출. 픽셀 모델은 환자
고유의 치아 형태를 외우므로 좌표 전용 KRR보다 누출에 훨씬 취약하다.

## 연결 경로
라벨 md 파일의 SHA-256이 index의 sourceAnnotationSha256s와 일치한다
(623/631 링크됨). 파일명에 차트번호가 있으므로 이를 경유해 환자를 복원한다.

## 파일명 규약 (차트번호는 실측 4자리)
  A) 001.md                   → 루트 3자리 사진 번호. 차트번호가 아니라 **별칭**.
  B) 2998000.md               → 차트 2998 + 000 패딩
     3166001.md               → 차트 3166 + 001 시퀀스
     3207.md                  → 차트 3207 (패딩 없음)
  C) 214520170104.md          → 차트 2145 + 날짜 20170104
     26052019061510.md        → 차트 2605 + 날짜 20190615 + 시퀀스 10
  D) 강다현(2142)_20170102.md  → 이름(차트 2142)_날짜

## 별칭 병합
한 케이스에 root3:001과 chart:2998이 동시에 붙으면 둘은 같은 환자의 서로 다른
이름이다(유라쌤은 루트 번호로, 김원장님은 차트번호로 같은 사진을 주석했다).
union-find로 병합해 하나의 환자로 접는다. 이 병합이 없으면 환자가 실제보다
많게 세어지고 누출이 남는다.

환자 이름은 저장하지 않는다(PHI). 차트번호만 쓴다.
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "03 AI 재학습" / "dataset-index.json"
OUT = ROOT / "03 AI 재학습" / "patient_groups.json"

LABEL_DIRS = [
    "01 치아 좌우폭 찍기 (유라쌤)",
    "02 치아 좌우폭 찍기(김원장님)",
    "03 치아 좌우폭 찍기(김원장님-클래스2)",
    "03 치아 좌우폭 찍기(유라쌤-클래스2)",
    "02 이퀼리브리엄 찍기(김원장님)",
    "02 교정 후 치아폭 찍기(김원장님)",
]

CHART_DIGITS = 4  # 실측: 2145, 2605, 2998, 3166, 3207, 3275 전부 4자리
RE_ROOT3 = re.compile(r"^\d{3}$")
RE_NAME_CHART = re.compile(r"^.+?\((\d{3,5})\)_(\d{8})(?:_\d+)?$")
RE_CHART_DATE = re.compile(r"^(\d{4})(\d{8})(\d*)$")
RE_NUMERIC = re.compile(r"^\d+$")


def keys_from_stem(stem: str) -> tuple[str, str]:
    """(patientKey, provenance). 이름은 절대 반환하지 않는다."""
    s = stem.strip().removesuffix(".md")
    if RE_ROOT3.match(s):
        # 3자리는 차트번호가 아니라 루트 사진 번호 → 별칭 키
        return f"root3:{s}", "three_digit_root_filename_alias"
    m = RE_NAME_CHART.match(s)
    if m:
        return f"chart:{int(m.group(1))}", "name_chart_date_filename"
    m = RE_CHART_DATE.match(s)
    if m and m.group(2).startswith(("19", "20")):
        return f"chart:{int(m.group(1))}", (
            "chart_plus_date_plus_seq_filename" if m.group(3) else "chart_plus_date_filename"
        )
    if RE_NUMERIC.match(s):
        # 4자리 접두 = 차트. 뒤는 000 패딩 또는 시퀀스.
        if len(s) >= CHART_DIGITS:
            return f"chart:{int(s[:CHART_DIGITS])}", (
                "bare_chart_filename" if len(s) == CHART_DIGITS else "chart_prefix_with_suffix_filename"
            )
        return f"chart:{int(s)}", "short_numeric_filename"
    return f"stem:{hashlib.sha256(s.encode()).hexdigest()[:16]}", "unparsed_filename_hashed"


class Union:
    """별칭 키를 하나의 환자로 접는 union-find."""

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def join(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        # chart: 키를 대표로 승격(실제 환자 식별자이고 사람이 읽을 수 있다)
        if rb.startswith("chart:") and not ra.startswith("chart:"):
            ra, rb = rb, ra
        elif ra.startswith("chart:") and rb.startswith("chart:"):
            ra, rb = sorted((ra, rb))
        self.parent[rb] = ra


def full12(case: dict) -> bool:
    for a in case.get("expert", {}).get("widthAnnotations", []):
        if len((a.get("raw") or {}).get("toothWidthsPx") or []) == 12:
            return True
    return False


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    index = json.loads(INDEX.read_text(encoding="utf-8-sig"))
    cases = index["cases"]

    sha_to_key: dict[str, tuple[str, str]] = {}
    prov_counter: Counter[str] = Counter()
    md_total = 0
    for directory in LABEL_DIRS:
        for path in sorted(glob.glob(os.path.join(ROOT, directory, "*.md"))):
            md_total += 1
            key, prov = keys_from_stem(os.path.splitext(os.path.basename(path))[0])
            sha_to_key[hashlib.sha256(Path(path).read_bytes()).hexdigest()] = (key, prov)
            prov_counter[prov] += 1

    # 1단계: 케이스별 후보 키 수집 + 같은 케이스에 붙은 키끼리 병합
    union = Union()
    case_keys: dict[str, set[str]] = {}
    case_provs: dict[str, set[str]] = {}
    for case in cases:
        cid = case["caseId"]
        keys: set[str] = set()
        provs: set[str] = set()
        for group in ("widthAnnotations", "ezAnnotations"):
            for annotation in case.get("expert", {}).get(group, []):
                hashes = list(annotation.get("sourceAnnotationSha256s", []))
                if annotation.get("labelSha256"):
                    hashes.append(annotation["labelSha256"])
                for value in hashes:
                    hit = sha_to_key.get(value)
                    if hit:
                        keys.add(hit[0])
                        provs.add(hit[1])
        case_keys[cid] = keys
        case_provs[cid] = provs
        ordered = sorted(keys)
        for key in ordered:
            union.find(key)
        for other in ordered[1:]:
            union.join(ordered[0], other)

    alias_merges = sum(1 for key in union.parent if union.find(key) != key)

    # 2단계: 대표 키로 환자 ID 확정
    assigned: dict[str, dict] = {}
    unresolved: list[str] = []
    for case in cases:
        cid = case["caseId"]
        image_sha = (case.get("image") or {}).get("sha256") or ""
        keys = case_keys[cid]
        if not keys:
            unresolved.append(cid)
            assigned[cid] = {
                "patientGroupId": f"imageonly:{image_sha[:16]}" if image_sha else f"case:{cid}",
                "provenance": "fallback_image_sha256_no_label_link",
                "aliasKeyCount": 0,
            }
            continue
        roots = {union.find(key) for key in keys}
        assigned[cid] = {
            "patientGroupId": sorted(roots)[0],
            "provenance": sorted(case_provs[cid])[0],
            "aliasKeyCount": len(keys),
            "residualDistinctRoots": len(roots) if len(roots) > 1 else None,
        }

    # 3단계: 누출 진단
    by_patient: dict[str, list[str]] = defaultdict(list)
    for cid, info in assigned.items():
        by_patient[info["patientGroupId"]].append(cid)

    train_ids = sorted(case["caseId"] for case in cases if full12(case))
    train_patients: dict[str, list[str]] = defaultdict(list)
    for cid in train_ids:
        train_patients[assigned[cid]["patientGroupId"]].append(cid)
    train_multi = {p: sorted(v) for p, v in train_patients.items() if len(v) > 1}
    leaked = sum(len(v) for v in train_multi.values())

    ez_ids = sorted(case["caseId"] for case in cases if case.get("expert", {}).get("ezAnnotations"))
    ez_patients: dict[str, list[str]] = defaultdict(list)
    for cid in ez_ids:
        ez_patients[assigned[cid]["patientGroupId"]].append(cid)
    ez_leaked = sum(len(v) for v in ez_patients.values() if len(v) > 1)

    report = {
        "schemaVersion": "patient-groups-v2",
        "privacy": {
            "containsPhi": False,
            "containsPatientNames": False,
            "containsFilePaths": False,
            "note": "환자 키는 4자리 차트번호 또는 파일명 해시. 이름은 저장하지 않음.",
        },
        "inputs": {
            "indexCases": len(cases),
            "labelMdFiles": md_total,
            "labelShaLinked": len(sha_to_key),
            "filenameProvenance": dict(sorted(prov_counter.items())),
        },
        "resolution": {
            "casesResolvedViaLabel": len(cases) - len(unresolved),
            "casesUnresolvedFallback": len(unresolved),
            "unresolvedCaseIds": unresolved,
            "aliasKeysMergedByUnionFind": alias_merges,
            "casesWithResidualDistinctRoots": sum(
                1 for info in assigned.values() if info.get("residualDistinctRoots")
            ),
        },
        "leakage": {
            "allCases": {
                "cases": len(cases),
                "uniquePatients": len(by_patient),
                "patientsWithMultipleImages": sum(1 for v in by_patient.values() if len(v) > 1),
            },
            "width12TrainingCases": {
                "cases": len(train_ids),
                "uniquePatients": len(train_patients),
                "patientsWithMultipleImages": len(train_multi),
                "leakableCases": leaked,
                "leakableCaseRate": round(leaked / max(len(train_ids), 1), 4),
            },
            "ezCases": {
                "cases": len(ez_ids),
                "uniquePatients": len(ez_patients),
                "leakableCases": ez_leaked,
                "leakableCaseRate": round(ez_leaked / max(len(ez_ids), 1), 4),
            },
        },
        "width12PatientSizeDistribution": dict(
            sorted(Counter(len(v) for v in train_patients.values()).items())
        ),
        "assignments": {
            cid: {k: v for k, v in info.items() if v is not None}
            for cid, info in sorted(assigned.items())
        },
    }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "assignments"},
                     ensure_ascii=False, indent=2))
    print(f"\n-> {OUT}")


if __name__ == "__main__":
    main()
