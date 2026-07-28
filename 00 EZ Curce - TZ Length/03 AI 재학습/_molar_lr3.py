#!/usr/bin/env python3
"""좌우 어금니 정확도 차이 3차 — 현재 모델(3단계·384건·bias 1.013)에서 재측정.

사용자 관찰(재차): "치아폭 선분의 위치와 길이가 왼쪽이 오른쪽 어금니보다 정확하다."

이전 측정([[project_molar_lr_asymmetry]], `_molar_lr.py`/`_molar_lr2.py`)은 격차
1.34%·CI 0 포함으로 **계통 편향 없음** 판정이었다. 그런데 그 뒤 모델이 두 번
바뀌었다(2단계→3단계, 268→384건, WIDTH_BIAS 1.051→1.013). 판정을 재사용하면 안 된다.

측정하는 것:
  A. 좌우 격차 재측정 — 위치·길이·부호편향, 시드 4종, 짝지어진 케이스 부트스트랩
  B. **정답 쪽 좌우 차이** — 라벨 자체가 한쪽에서 더 흩어지는가(같은 이미지에 정답이
     둘 있는 케이스에서 좌우별 정답-정답 불일치). 모델을 탓하기 전에 확인해야 한다.
  C. 규칙엔진 초안의 좌우 격차 — 비대칭이 초안에서 오는가 잔차보정에서 오는가
  D. 치아별 프로파일 — 좌우가 아니라 **최말단(1·12)** 효과인지 분리
     (이전 결론: 진짜 병목은 좌우가 아니라 최말단, 중앙 대비 2.1배)
  E. 케이스별 분포 — "평균은 대칭인데 케이스마다 한쪽이 나쁘다"인지
     (오른쪽이 더 나쁜 케이스 비율, 그 크기)
  F. 클래스2/비클래스2 분리 — 코호트 구성이 좌우 격차를 만드는지

좌우 규약: 1차 측정에서 치아 1·2가 항상 영상 왼쪽으로 확인됐다. 그 규약이 384건에서도
유지되는지 **다시 확인**한다(신규 116건이 들어왔으므로).

mm는 정답 최외곽 스팬=54mm, 픽셀 등방 공간. 출력에 PHI·좌표·파일명·담당자명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _class2_scale_test import class2_mask
from _class2b_bias import scale_about_midpoint
from _more_labels import CUMULATIVE, PER_STAGE, STAGE_HYPER
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _truth_agreement import annotation_points, cohort_of
from _cohort_scale_map import label_sha_to_cohort

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEEDS = (20260711, 20260712, 20260713, 20260714)
BOOTSTRAP = 5000
WIDTH_BIAS = 1.013
LEFT_TEETH = (0, 1)     # 0-based: 치아 1·2
RIGHT_TEETH = (10, 11)  # 치아 11·12
LEFT_TERMINAL = 0
RIGHT_TERMINAL = 11


def side_metrics(pred_px, truth_px):
    """좌우별 위치 mm / 길이 절대오차 mm / 길이 부호오차(%)를 케이스별로."""
    scale = truth_scale_px(truth_px)
    mid_p = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    pos = np.linalg.norm(mid_p - mid_t, axis=2) * scale[:, None]
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2) * scale[:, None]
    signed = (pl - tl) / np.maximum(tl, 1e-9) * 100.0
    out = {}
    for name, idx in (("left", list(LEFT_TEETH)), ("right", list(RIGHT_TEETH))):
        out[f"{name}Position"] = pos[:, idx].mean(axis=1)
        out[f"{name}LengthAbs"] = np.abs(pl - tl)[:, idx].mean(axis=1)
        out[f"{name}LengthSigned"] = signed[:, idx].mean(axis=1)
    out["leftTerminalPosition"] = pos[:, LEFT_TERMINAL]
    out["rightTerminalPosition"] = pos[:, RIGHT_TERMINAL]
    out["leftTerminalLengthAbs"] = np.abs(pl - tl)[:, LEFT_TERMINAL]
    out["rightTerminalLengthAbs"] = np.abs(pl - tl)[:, RIGHT_TERMINAL]
    out["perToothPosition"] = pos          # (cases, 12) - 치아별 프로파일용
    out["perToothLengthAbs"] = np.abs(pl - tl)
    return out


def gap_bootstrap(left: np.ndarray, right: np.ndarray, seed: int) -> dict:
    """(오른쪽 − 왼쪽) 격차와 그 상대비(%). 케이스 단위 짝지어진 부트스트랩."""
    rng = np.random.default_rng(seed)
    n = len(left)
    delta = right - left
    gains = []
    for _ in range(BOOTSTRAP):
        pick = rng.integers(0, n, n)
        gains.append(delta[pick].mean() / max(left[pick].mean(), 1e-12) * 100.0)
    low, high = float(np.quantile(gains, 0.025)), float(np.quantile(gains, 0.975))
    return {
        "leftMm": round(float(left.mean()), 4),
        "rightMm": round(float(right.mean()), 4),
        "gapMm": round(float(delta.mean()), 4),
        "rightWorseByPercent": round(float(delta.mean() / max(left.mean(), 1e-12) * 100.0), 2),
        "ci95Percent": [round(low, 2), round(high, 2)],
        "significant": bool(low > 0 or high < 0),
        "casesRightWorseFraction": round(float((delta > 0).mean()), 3),
    }


def verify_side_convention(truth_px: np.ndarray) -> dict:
    """치아 1·2가 영상 왼쪽(x가 작은 쪽)인가 — 384건에서 재확인."""
    mid = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    left_x = mid[:, list(LEFT_TEETH), 0].mean(axis=1)
    right_x = mid[:, list(RIGHT_TEETH), 0].mean(axis=1)
    consistent = int((left_x < right_x).sum())
    return {"cases": int(len(truth_px)),
            "tooth1and2OnImageLeft": consistent,
            "flipped": int(len(truth_px) - consistent),
            "convention": "tooth 1,2 = image left" if consistent == len(truth_px)
                          else "MIXED - direction convention is not consistent"}


def truth_side_disagreement() -> dict | None:
    """정답끼리의 좌우별 불일치 — 라벨 쪽이 한쪽에서 더 흩어지는가.

    같은 이미지에 완전 정답이 둘 있는 케이스에서, 좌우 어금니의 정답-정답 차이를 따로 본다.
    """
    document = json.loads((HERE / "dataset-index.json").read_text(encoding="utf-8"))
    sha_to_cohort = label_sha_to_cohort()
    rows = []
    for case in document["cases"]:
        complete = []
        for annotation in case["expert"]["widthAnnotations"]:
            pts = annotation_points(annotation)
            if pts is None:
                continue
            complete.append((cohort_of(annotation, sha_to_cohort) or "unknown", pts))
        if len(complete) < 2:
            continue
        complete.sort(key=lambda item: item[0])
        pts_a, pts_b = complete[0][1], complete[1][1]
        # 자기 스팬으로 mm 환산(스케일 가정 차이를 제거)
        flat_a, flat_b = pts_a.reshape(1, -1, 2), pts_b.reshape(1, -1, 2)
        scale_a = truth_scale_px(flat_a)[0]
        mid_a = pts_a.mean(axis=1)
        mid_b = pts_b.mean(axis=1)
        pos = np.linalg.norm(mid_a - mid_b, axis=1) * scale_a
        len_a = np.linalg.norm(pts_a[:, 0, :] - pts_a[:, 1, :], axis=1) * scale_a
        len_b = np.linalg.norm(pts_b[:, 0, :] - pts_b[:, 1, :], axis=1) * scale_a
        rows.append({
            "leftPosition": float(pos[list(LEFT_TEETH)].mean()),
            "rightPosition": float(pos[list(RIGHT_TEETH)].mean()),
            "leftLengthAbs": float(np.abs(len_a - len_b)[list(LEFT_TEETH)].mean()),
            "rightLengthAbs": float(np.abs(len_a - len_b)[list(RIGHT_TEETH)].mean()),
        })
    if len(rows) < 8:
        return None
    out = {"casesCompared": len(rows)}
    for metric in ("Position", "LengthAbs"):
        left = np.asarray([r[f"left{metric}"] for r in rows])
        right = np.asarray([r[f"right{metric}"] for r in rows])
        out[metric] = gap_bootstrap(left, right, 20260728)
    return out


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)
    x, base, target = width["x"], width["baseline"], width["target"]
    truth_px = to_pixels(target.reshape(-1, 24, 2), groups, dims)
    base_px = to_pixels(base.reshape(-1, 24, 2), groups, dims)
    is_class2 = class2_mask(dataset_path, groups)

    convention = verify_side_convention(truth_px)

    # ── 규칙엔진 초안의 좌우 격차 ──────────────────────────────────────────────
    rule = side_metrics(base_px, truth_px)
    rule_gaps = {
        "position": gap_bootstrap(rule["leftPosition"], rule["rightPosition"], 20260728),
        "lengthAbs": gap_bootstrap(rule["leftLengthAbs"], rule["rightLengthAbs"], 20260728),
        "terminalPosition": gap_bootstrap(rule["leftTerminalPosition"],
                                          rule["rightTerminalPosition"], 20260728),
    }

    # ── KRR OOF 좌우 격차 (시드 4종) ───────────────────────────────────────────
    per_seed = []
    accumulated = {}
    order = []
    for seed in SEEDS:
        collected: dict[str, list[np.ndarray]] = {}
        rows_order = []
        for index, test_mask in enumerate(tr.grouped_folds(groups, FOLDS, seed), start=1):
            train_mask = ~test_mask
            models = tr.fit_stages(x[train_mask], base[train_mask], target[train_mask],
                                   STAGE_HYPER, PER_STAGE, CUMULATIVE)
            prediction = tr.predict_stages(models, x[test_mask], base[test_mask],
                                           PER_STAGE, CUMULATIVE)[0]
            rows = np.flatnonzero(test_mask)
            pred_px = scale_about_midpoint(
                to_pixels(prediction.reshape(-1, 24, 2), groups[rows], dims), WIDTH_BIAS)
            for key, values in side_metrics(pred_px, truth_px[rows]).items():
                collected.setdefault(key, []).append(values)
            rows_order.append(rows)
        metrics = {k: np.concatenate(v) for k, v in collected.items()}
        rows_all = np.concatenate(rows_order)
        seed_row = {
            "seed": seed,
            "position": gap_bootstrap(metrics["leftPosition"], metrics["rightPosition"], seed),
            "lengthAbs": gap_bootstrap(metrics["leftLengthAbs"], metrics["rightLengthAbs"], seed),
            "lengthSignedLeftPercent": round(float(metrics["leftLengthSigned"].mean()), 3),
            "lengthSignedRightPercent": round(float(metrics["rightLengthSigned"].mean()), 3),
            "terminalPosition": gap_bootstrap(metrics["leftTerminalPosition"],
                                              metrics["rightTerminalPosition"], seed),
            "terminalLengthAbs": gap_bootstrap(metrics["leftTerminalLengthAbs"],
                                               metrics["rightTerminalLengthAbs"], seed),
        }
        flag = is_class2[rows_all]
        for label, sel in (("class2", flag), ("other", ~flag)):
            if sel.sum() < 10:
                continue
            seed_row[f"position_{label}"] = gap_bootstrap(
                metrics["leftPosition"][sel], metrics["rightPosition"][sel], seed)
        per_seed.append(seed_row)
        if not accumulated:
            accumulated = {k: metrics[k] for k in ("perToothPosition", "perToothLengthAbs")}
            order = rows_all

    def across(path: str, field: str = "rightWorseByPercent"):
        values = [row[path][field] for row in per_seed]
        sig = [row[path]["significant"] for row in per_seed]
        return {"meanPercent": round(float(np.mean(values)), 2),
                "perSeed": values,
                "seedsSignificant": f"{sum(sig)}/{len(sig)}"}

    # ── 치아별 프로파일: 좌우 대칭 위치끼리 비교 ────────────────────────────────
    pos_per_tooth = accumulated["perToothPosition"].mean(axis=0)
    len_per_tooth = accumulated["perToothLengthAbs"].mean(axis=0)
    mirror = []
    for k in range(6):
        left_i, right_i = k, 11 - k
        mirror.append({
            "pairFromEnd": k + 1,
            "leftToothIndex": left_i + 1,
            "rightToothIndex": right_i + 1,
            "leftPositionMm": round(float(pos_per_tooth[left_i]), 4),
            "rightPositionMm": round(float(pos_per_tooth[right_i]), 4),
            "rightMinusLeftMm": round(float(pos_per_tooth[right_i] - pos_per_tooth[left_i]), 4),
            "leftLengthAbsMm": round(float(len_per_tooth[left_i]), 4),
            "rightLengthAbsMm": round(float(len_per_tooth[right_i]), 4),
        })

    report = {
        "schemaVersion": "molar-lr3-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("좌우 어금니 정확도 격차를 현재 모델(3단계, 384건, WIDTH_BIAS "
                 f"{WIDTH_BIAS})에서 재측정. 왼쪽=치아1·2, 오른쪽=치아11·12. "
                 "격차는 (오른쪽 − 왼쪽)이며 양수면 오른쪽이 더 나쁘다. "
                 f"픽셀 등방 mm(스팬=54mm), 시드 {list(SEEDS)}, 부트스트랩 {BOOTSTRAP}회."),
        "sideConvention": convention,
        "ruleEngineDraftGaps": rule_gaps,
        "krrOutOfFold": {
            "position": across("position"),
            "lengthAbs": across("lengthAbs"),
            "terminalPosition": across("terminalPosition"),
            "terminalLengthAbs": across("terminalLengthAbs"),
            "positionClass2": across("position_class2") if "position_class2" in per_seed[0] else None,
            "positionOther": across("position_other") if "position_other" in per_seed[0] else None,
            "signedLengthLeftPercent": round(
                float(np.mean([r["lengthSignedLeftPercent"] for r in per_seed])), 3),
            "signedLengthRightPercent": round(
                float(np.mean([r["lengthSignedRightPercent"] for r in per_seed])), 3),
            "perSeed": per_seed,
        },
        "mirrorPairProfile": mirror,
        "truthSideDisagreement": truth_side_disagreement(),
    }
    (HERE / "molar_lr3.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"side convention: {convention['convention']} "
          f"({convention['tooth1and2OnImageLeft']}/{convention['cases']})")
    print("\nrule engine draft, right minus left:")
    for key, row in rule_gaps.items():
        print(f"   {key:18s} L {row['leftMm']:.3f} R {row['rightMm']:.3f} "
              f"-> {row['rightWorseByPercent']:+.2f}% ci {row['ci95Percent']} "
              f"sig {row['significant']}")
    print("\nKRR OOF, right minus left (mean over 4 seeds):")
    for key in ("position", "lengthAbs", "terminalPosition", "terminalLengthAbs"):
        row = report["krrOutOfFold"][key]
        print(f"   {key:18s} {row['meanPercent']:+.2f}%  perSeed {row['perSeed']}  "
              f"sig {row['seedsSignificant']}")
    print(f"   signed length  left {report['krrOutOfFold']['signedLengthLeftPercent']:+.2f}%  "
          f"right {report['krrOutOfFold']['signedLengthRightPercent']:+.2f}%")
    for key in ("positionClass2", "positionOther"):
        row = report["krrOutOfFold"].get(key)
        if row:
            print(f"   {key:18s} {row['meanPercent']:+.2f}%  sig {row['seedsSignificant']}")
    print("\nmirror pair profile (position mm, 1 = outermost):")
    for row in mirror:
        print(f"   pair{row['pairFromEnd']}  tooth{row['leftToothIndex']:2d} "
              f"{row['leftPositionMm']:.3f}  vs tooth{row['rightToothIndex']:2d} "
              f"{row['rightPositionMm']:.3f}   diff {row['rightMinusLeftMm']:+.3f}")
    truth = report["truthSideDisagreement"]
    if truth:
        print(f"\ntruth-vs-truth side disagreement (n={truth['casesCompared']}):")
        for metric in ("Position", "LengthAbs"):
            row = truth[metric]
            print(f"   {metric:10s} L {row['leftMm']:.3f} R {row['rightMm']:.3f} "
                  f"-> {row['rightWorseByPercent']:+.2f}% ci {row['ci95Percent']} "
                  f"sig {row['significant']}")


if __name__ == "__main__":
    main()
