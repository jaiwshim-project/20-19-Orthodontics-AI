#!/usr/bin/env python3
"""AI 오차가 "정답처럼" 되려면 얼마나 남았나 — 허용 오차 대비 + 384건 학습곡선.

사용자 질문: "550장 정답을 줬는데 정확도가 왜 안 올라가나. AI 결과가 정답으로
제공된 것처럼 나와야 한다."

두 가지를 같은 단위(mm)에서 붙여 답한다.

  ① 지금 3단계 KRR의 OOF 오차 (384건 전부, 시드 1개, 픽셀 등방 mm)
  ② `truth_agreement.json`의 정답-정답 차이 = **허용 오차(=도달 상한)**
     같은 이미지에 두 정답이 있을 때 둘이 얼마나 다른지. 사용자 전제상 둘 다
     정답이므로, AI가 이보다 더 정확해질 수는 없다(정의상).
  ③ 학습곡선: 384건 중 40~100%만 써서 오차가 실제로 내려가는지.
     내려가면 "라벨이 더 필요"가 맞고, 평평하면 라벨이 아니라 **모델·특징**이
     병목이다. 이걸 재지 않고 "라벨 더 주세요"라고 하면 안 된다.
  ④ 클래스2 / 비클래스2로 쪼개서 곡선을 따로 본다(클래스 정보 부재의 대가).

3단계·현행 하이퍼(gamma 0.25, cap 0.05/0.15)·WIDTH_BIAS 1.013 = 연구용 HTML과 동일.
출력에 PHI·좌표·파일명·담당자명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _class2_scale_test import class2_mask
from _class2b_bias import case_metrics, scale_about_midpoint
from _more_labels import CUMULATIVE, PER_STAGE, STAGE_HYPER
from _px_decompose import dims_by_group, to_pixels

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEEDS = (20260711, 20260712, 20260713, 20260714)
FRACTIONS = (0.4, 0.55, 0.7, 0.85, 1.0)
WIDTH_BIAS = 1.013
KEYS = ("position", "molar", "terminal", "lengthAbs", "tzl")


def oof_at_fraction(x, base, target, groups, dims, truth_px, fraction, seed):
    """그룹 단위 5-fold OOF. fraction<1이면 train 그룹을 그만큼만 남긴다."""
    collected: dict[str, list[np.ndarray]] = {}
    order: list[np.ndarray] = []
    sizes = []
    for index, test_mask in enumerate(tr.grouped_folds(groups, FOLDS, seed), start=1):
        train_mask = ~test_mask
        if fraction < 1.0:
            train_groups = np.unique(groups[train_mask])
            rng = np.random.default_rng(seed + index * 977 + int(fraction * 1000))
            keep = rng.choice(train_groups,
                              size=max(8, int(round(len(train_groups) * fraction))),
                              replace=False)
            train_mask = train_mask & np.isin(groups, keep)
        sizes.append(int(train_mask.sum()))
        models = tr.fit_stages(x[train_mask], base[train_mask], target[train_mask],
                               STAGE_HYPER, PER_STAGE, CUMULATIVE)
        prediction = tr.predict_stages(models, x[test_mask], base[test_mask],
                                       PER_STAGE, CUMULATIVE)[0]
        rows = np.flatnonzero(test_mask)
        pred_px = scale_about_midpoint(
            to_pixels(prediction.reshape(-1, 24, 2), groups[rows], dims), WIDTH_BIAS)
        for key, values in case_metrics(pred_px, truth_px[rows]).items():
            collected.setdefault(key, []).append(values)
        order.append(rows)
    rows = np.concatenate(order)
    metrics = {k: np.concatenate(v) for k, v in collected.items()}
    return metrics, rows, float(np.mean(sizes))


def summarize(metrics: dict[str, np.ndarray], sel: np.ndarray | None = None) -> dict:
    out = {}
    for key in KEYS:
        values = metrics[key] if sel is None else metrics[key][sel]
        out[key] = round(float(values.mean()), 4)
    return out


def slope(sizes, values) -> float:
    """오차 ~ N^slope. 음수일수록 라벨이 효과 있다."""
    return float(np.polyfit(np.log(np.asarray(sizes)), np.log(np.asarray(values)), 1)[0])


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)
    x, base, target = width["x"], width["baseline"], width["target"]
    truth_px = to_pixels(target.reshape(-1, 24, 2), groups, dims)
    is_class2 = class2_mask(dataset_path, groups)

    # ── 규칙엔진 초안(보정 전) 자체 오차 — 출발점 ──────────────────────────────
    base_px = to_pixels(base.reshape(-1, 24, 2), groups, dims)
    rule = case_metrics(base_px, truth_px)
    rule_summary = {
        "all": summarize(rule),
        "class2": summarize(rule, is_class2),
        "other": summarize(rule, ~is_class2),
    }

    # ── 학습곡선 (시드 평균) ────────────────────────────────────────────────────
    curve: dict[str, dict] = {}
    for fraction in FRACTIONS:
        per_seed_all, per_seed_c2, per_seed_other, sizes = [], [], [], []
        for seed in SEEDS:
            metrics, rows, mean_size = oof_at_fraction(
                x, base, target, groups, dims, truth_px, fraction, seed)
            flag = is_class2[rows]
            per_seed_all.append(summarize(metrics))
            per_seed_c2.append(summarize(metrics, flag))
            per_seed_other.append(summarize(metrics, ~flag))
            sizes.append(mean_size)
        def average(rows_list):
            return {k: round(float(np.mean([r[k] for r in rows_list])), 4) for k in KEYS}
        curve[f"{fraction:.2f}"] = {
            "meanTrainSamples": round(float(np.mean(sizes)), 1),
            "all": average(per_seed_all),
            "class2": average(per_seed_c2),
            "other": average(per_seed_other),
        }

    sizes = [curve[f"{f:.2f}"]["meanTrainSamples"] for f in FRACTIONS]
    slopes = {
        scope: {key: round(slope(sizes, [curve[f"{f:.2f}"][scope][key] for f in FRACTIONS]), 3)
                for key in KEYS}
        for scope in ("all", "class2", "other")
    }

    # ── 허용 오차(정답-정답) 대비 ───────────────────────────────────────────────
    agreement_path = HERE / "truth_agreement.json"
    tolerance = None
    if agreement_path.exists():
        doc = json.loads(agreement_path.read_text(encoding="utf-8"))
        tolerance = {
            "casesCompared": doc["casesCompared"],
            "endpointMm": doc["overall"]["endpointMm"]["mean"],
            "lengthDiffMm": doc["overall"]["lengthDiffMm"]["mean"],
            "tzlAbsDiffMm": doc["overall"]["tzlAbsDiffMm"]["mean"],
            "tzlOwnScaleAbsMm": doc["overall"]["tzlOwnScaleAbsMm"]["mean"],
        }

    full = curve[f"{1.0:.2f}"]
    ratio = None
    if tolerance:
        ratio = {
            "lengthAbs_over_truthLengthDiff": round(
                full["all"]["lengthAbs"] / tolerance["lengthDiffMm"], 2),
            "tzl_over_truthTzlAbsDiff": round(
                full["all"]["tzl"] / tolerance["tzlAbsDiffMm"], 2),
            "tzl_over_truthTzlOwnScale": round(
                full["all"]["tzl"] / tolerance["tzlOwnScaleAbsMm"], 2),
            "position_over_truthEndpoint": round(
                full["all"]["position"] / tolerance["endpointMm"], 2),
        }

    report = {
        "schemaVersion": "accuracy-ceiling-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("384건 전체를 쓴 3단계 KRR의 OOF 오차를 (1) 규칙엔진 초안, "
                 "(2) 정답-정답 허용 오차, (3) 학습곡선 기울기와 함께 본다. "
                 f"픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm, 시드 {list(SEEDS)} 평균, "
                 f"WIDTH_BIAS {WIDTH_BIAS}, 3단계 캡 {PER_STAGE}/{CUMULATIVE}."),
        "counts": {"widthSamples": int(x.shape[0]),
                   "class2": int(is_class2.sum()),
                   "other": int((~is_class2).sum())},
        "ruleEngineDraft": rule_summary,
        "krrOutOfFold": {"all": full["all"], "class2": full["class2"], "other": full["other"]},
        "learningCurve": curve,
        "learningCurveSlopes": slopes,
        "slopeInterpretation": ("기울기가 0에 가까우면 라벨을 더 넣어도 오차가 안 준다 "
                               "= 병목은 라벨 수가 아니라 모델·특징이다. -0.5는 교과서적 "
                               "학습곡선, -0.1보다 완만하면 포화."),
        "truthTolerance": tolerance,
        "krrErrorOverTolerance": ratio,
        "ratioInterpretation": ("1.0이면 AI 오차가 정답끼리의 차이와 같다 = 정의상 상한 도달. "
                               "1보다 크면 그 배수만큼 남아 있다."),
    }
    (HERE / "accuracy_ceiling.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"width samples {report['counts']['widthSamples']} "
          f"(class2 {report['counts']['class2']} / other {report['counts']['other']})\n")
    print("mean error in mm - rule draft vs KRR OOF (384 labels, 4 seeds):")
    print(f"   {'metric':10s} {'rule':>8s} {'KRR':>8s} {'gain':>8s}")
    for key in KEYS:
        r, k = rule_summary["all"][key], full["all"][key]
        print(f"   {key:10s} {r:8.3f} {k:8.3f} {(1 - k / r) * 100:+7.1f}%")
    print("\nlearning curve (all cases, mm):")
    print(f"   {'trainN':>8s} " + " ".join(f"{k:>10s}" for k in KEYS))
    for fraction in FRACTIONS:
        row = curve[f"{fraction:.2f}"]
        print(f"   {row['meanTrainSamples']:8.1f} " +
              " ".join(f"{row['all'][k]:10.3f}" for k in KEYS))
    print("\nlog-log slopes (more negative = labels still help):")
    for scope in ("all", "class2", "other"):
        print(f"   {scope:8s} " + " ".join(f"{k}={slopes[scope][k]:+.3f}" for k in KEYS))
    if tolerance:
        print(f"\ntruth-vs-truth tolerance (n={tolerance['casesCompared']} shared images):")
        for key, value in tolerance.items():
            if key != "casesCompared":
                print(f"   {key:22s} {value:8.3f} mm")
        print("\nKRR error / tolerance:")
        for key, value in ratio.items():
            print(f"   {key:34s} {value:6.2f}x")


if __name__ == "__main__":
    main()
