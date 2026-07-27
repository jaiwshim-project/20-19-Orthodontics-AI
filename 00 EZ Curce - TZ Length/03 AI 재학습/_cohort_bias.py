#!/usr/bin/env python3
"""왜 전역 prior 재교정이 실패했는가 — 라벨 코호트별 폭 스케일 차이.

`_rule_ab_px.py` 결과: 185건에서 산출한 prior 보정계수(x1.12)를 root 83건에
적용하면 길이 오차가 25% 악화됐다. 원인 가설: 두 라벨 코호트의 **정답 폭 스케일
자체가 다르다**(같은 54mm 스팬 기준인데 12치 폭 합이 다르다).

  root      : 초기 119장(001~119.jpg) 라벨
  nonRoot   : 이후 추가된 임베드 라벨(교정후 114장 + 클래스2 99건 등)

이게 사실이면 prior 같은 **전역 상수 12개로는 두 코호트를 동시에 맞출 수 없고**,
케이스별 특징에 조건화된 잔차보정(KRR)만이 옳은 층이다. 검증 방법은 코호트별
정답 폭 통계와 초안-정답 길이 부호오차를 나란히 재고, 코호트 라벨을 무작위로
섞은 순열검정으로 그 격차가 우연인지 본다.

학습 없음. mm는 정답 최외곽 스팬=54mm 기준. 출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
PERMUTATIONS = 5000
MOLAR_IDX = [0, 1, 10, 11]


def root_shas() -> set[str]:
    out = set()
    for n in range(1, 120):
        path = PROJECT / f"{n:03d}.jpg"
        if path.exists():
            out.add(hashlib.sha256(path.read_bytes()).hexdigest())
    return out


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)
    # root_shas()는 JPG 119장을 해싱하므로 루프 밖에서 한 번만 부른다.
    root = root_shas()
    is_root = np.array([str(g) in root for g in groups])

    tw = np.stack([np.linalg.norm(truth[:, 2 * t] - truth[:, 2 * t + 1], axis=1) * scale
                   for t in range(12)], axis=1)
    dw = np.stack([np.linalg.norm(draft[:, 2 * t] - draft[:, 2 * t + 1], axis=1) * scale
                   for t in range(12)], axis=1)
    len_pct = (dw - tw) / np.maximum(tw, EPS) * 100
    tzl = tw.sum(axis=1)  # 케이스별 12치 폭 합(정답)

    def cohort(mask, label) -> dict:
        return {
            "label": label,
            "cases": int(mask.sum()),
            "truthTzlMeanMm": float(tzl[mask].mean()),
            "truthTzlStdMm": float(tzl[mask].std()),
            "draftLengthSignedPct": float(len_pct[mask].mean()),
            "draftLengthSignedPctMolar": float(len_pct[mask][:, MOLAR_IDX].mean()),
            "neededPriorFactor": float((tw[mask].mean(axis=0) / np.maximum(dw[mask].mean(axis=0), EPS)).mean()),
        }

    root_block = cohort(is_root, "root(초기 119장 라벨)")
    other_block = cohort(~is_root, "nonRoot(추가 임베드 라벨)")

    # 순열검정: 코호트 라벨을 섞어도 TZL 격차가 나오는가
    rng = np.random.default_rng(SEED)
    observed = abs(tzl[is_root].mean() - tzl[~is_root].mean())
    n_root = int(is_root.sum())
    null = np.empty(PERMUTATIONS)
    for i in range(PERMUTATIONS):
        perm = rng.permutation(len(tzl))
        null[i] = abs(tzl[perm[:n_root]].mean() - tzl[perm[n_root:]].mean())
    p_value = float((null >= observed).mean())

    report = {
        "schemaVersion": "cohort-bias-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("전역 prior 재교정 실패 원인 규명. 라벨 코호트별 정답 폭 스케일과 초안 길이 "
                 "부호오차를 비교하고, 코호트 격차를 순열검정으로 검정한다. 학습 없음. "
                 "mm는 정답 최외곽 스팬=54mm 기준."),
        "samples": int(len(tzl)),
        "cohorts": [root_block, other_block],
        "gap": {
            "truthTzlGapMm": float(other_block["truthTzlMeanMm"] - root_block["truthTzlMeanMm"]),
            "truthTzlGapPct": float((other_block["truthTzlMeanMm"] - root_block["truthTzlMeanMm"])
                                    / root_block["truthTzlMeanMm"] * 100),
            "lengthBiasGapPp": float(root_block["draftLengthSignedPct"] - other_block["draftLengthSignedPct"]),
            "priorFactorRoot": root_block["neededPriorFactor"],
            "priorFactorNonRoot": other_block["neededPriorFactor"],
            "permutationPValue": p_value,
            "significant": bool(p_value < 0.05),
        },
        "perTooth": [{
            "tooth": t + 1,
            "rootTruthMm": round(float(tw[is_root][:, t].mean()), 2),
            "nonRootTruthMm": round(float(tw[~is_root][:, t].mean()), 2),
            "gapPct": round(float((tw[~is_root][:, t].mean() - tw[is_root][:, t].mean())
                                  / tw[is_root][:, t].mean() * 100), 1),
            "rootNeededFactor": round(float(tw[is_root][:, t].mean() / max(dw[is_root][:, t].mean(), EPS)), 3),
            "nonRootNeededFactor": round(float(tw[~is_root][:, t].mean() / max(dw[~is_root][:, t].mean(), EPS)), 3),
        } for t in range(12)],
    }
    # 코호트 차이가 라벨자 스케일 관습 때문인가, 촬영 조건(해상도/구도) 때문인가
    diagonal = np.hypot(np.array([dims[str(g)][0] for g in groups]),
                        np.array([dims[str(g)][1] for g in groups]))
    span = np.array([max(float(np.linalg.norm(truth[k][i + 1:] - truth[k][i], axis=1).max())
                         for i in range(23)) for k in range(len(groups))])
    bias_case = len_pct.mean(axis=1)
    root_like = (~is_root) & (diagonal > np.quantile(diagonal[is_root], 0.25))
    report["confounders"] = {
        "corrBiasVsImageDiagonal": float(np.corrcoef(bias_case, diagonal)[0, 1]),
        "corrBiasVsArchSpanFraction": float(np.corrcoef(bias_case, span / diagonal)[0, 1]),
        "corrBiasVsCohort": float(np.corrcoef(bias_case, is_root.astype(float))[0, 1]),
        "withinRootCorrBiasVsDiagonal": float(np.corrcoef(bias_case[is_root], diagonal[is_root])[0, 1]),
        "withinNonRootCorrBiasVsDiagonal": float(np.corrcoef(bias_case[~is_root], diagonal[~is_root])[0, 1]),
        "nonRootAtRootLikeResolution": {
            "cases": int(root_like.sum()),
            "lengthSignedPct": float(bias_case[root_like].mean()),
            "note": ("해상도를 root 수준으로 맞춰도 부호오차가 남으면 해상도 교란이 아니라 "
                     "라벨 관습 차이다."),
        },
    }
    report["conclusion"] = {
        "verdict": ("cohort scale differs: a global 12-constant prior cannot fit both"
                    if report["gap"]["significant"] else "no cohort difference"),
        "implication": ("정답 폭 스케일이 코호트마다 다르므로 전역 상수(prior) 조정은 한쪽을 맞추면 "
                        "다른 쪽을 망친다. 케이스별 특징에 조건화되는 잔차보정(KRR)이 옳은 층이다."),
    }

    (HERE / "cohort_bias.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for c in (root_block, other_block):
        print(f"{c['label']}: n={c['cases']}  truthTZL {c['truthTzlMeanMm']:.1f} mm  "
              f"draftLen {c['draftLengthSignedPct']:+.1f}%  neededFactor x{c['neededPriorFactor']:.3f}")
    print("\ngap:", json.dumps(report["gap"], ensure_ascii=False, indent=2))
    print("\ntooth rootTruth nonRootTruth gap%  rootFactor nonRootFactor")
    for r in report["perTooth"]:
        print(f"{r['tooth']:5d} {r['rootTruthMm']:9.2f} {r['nonRootTruthMm']:12.2f} {r['gapPct']:5.1f} "
              f"{r['rootNeededFactor']:10.3f} {r['nonRootNeededFactor']:13.3f}")
    print("\nconfounders:", json.dumps(report["confounders"], ensure_ascii=True, indent=2))
    print("\nconclusion:", json.dumps(report["conclusion"], ensure_ascii=True))


if __name__ == "__main__":
    main()
