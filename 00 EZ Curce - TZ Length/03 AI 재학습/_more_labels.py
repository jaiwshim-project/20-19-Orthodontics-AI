#!/usr/bin/env python3
"""지금 확보된 정답으로 더 학습할 수 있는가 — 버려지고 있는 라벨의 가치 실측.

배경: `train_residual.build_samples`는 치아 12개가 **모두** 주석된 케이스만 폭 학습에
넣는다(현재 268건). 그런데 디스크에는 부분 주석 케이스가 더 있고, 빠진 치아는 대부분
최말단(치아 11·12)이다 — 하필 오차가 가장 큰 자리다. 이들을 통째로 버리는 대신
**치아 단위로** 쓸 수 있다면 라벨을 새로 받지 않고도 학습량이 늘어난다.

왜 치아 단위 학습이 가능한가: KRR의 alpha는 출력 열마다 독립적으로 풀린다
(`alpha = (K+λI)^{-1}(target-baseline)`). 또 per-stage/누적 캡은 **랜드마크 단위**라
치아별로 나눠 적용해도 전체 벡터에 적용한 것과 수치가 동일하다. 따라서 치아 t의
4개 출력 열은 "치아 t가 주석된 케이스"만으로 학습해도 나머지 치아와 독립적으로 맞다.

측정 설계(A/B, 동일 하이퍼파라미터):
  A(현행 상당) = 완전 주석 케이스만으로 치아별 학습
  B(증강)      = A + 부분 주석 케이스의 해당 치아 정답까지 학습
  평가는 **양쪽 동일하게 완전 주석 케이스의 out-of-fold 예측**으로만 한다.
  부분 주석 케이스는 어느 폴드에서도 test에 들어가지 않는다(정답이 없으니 불가능).
  하이퍼파라미터는 배포 모델의 단계별 값을 양쪽에 그대로 써서 차이를 학습 데이터로만 한정.

⚠️ A는 "현행 상당"이지 현행 모델 자체가 아니다. 현행은 24개 출력을 한 프로토타입
집합으로 함께 풀고 내부 CV로 하이퍼파라미터를 고른다. 여기서는 치아별로 쪼갰고
하이퍼파라미터를 고정했으므로, **A 대비 B의 차이**만 해석하고 A의 절대값을 배포
모델 성적과 비교하지 말 것.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_px import paired

HERE = Path(__file__).resolve().parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
FOLDS = 5
PER_STAGE = 0.05
CUMULATIVE = 0.15
WIDTH_BIAS = 1.013
MOLAR_IDX = [0, 1, 10, 11]
TERMINAL_IDX = [0, 11]
# 배포 모델(residual-model.json)의 단계별 하이퍼파라미터. A/B 양쪽에 동일 적용.
STAGE_HYPER = ((0.25, 0.1), (0.25, 1.0), (4.0, 1.0))


# ── 정답 인벤토리 ────────────────────────────────────────────────────────────

def tooth_truth_by_case(dataset_path: Path) -> tuple[dict, dict]:
    """케이스별 치아번호 → 정규화 좌표(2점). 부분 주석도 그대로 살린다.

    여러 주석 버전이 있으면 치아별로 평균한다(`truth_consensus`와 같은 관습).
    """
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    cases = tr.dataset_cases(document)
    per_case: dict[str, dict[int, np.ndarray]] = {}
    dims_by_case: dict[str, tuple[float, float]] = {}
    for case in cases:
        image = case.get("image") if isinstance(case.get("image"), dict) else {}
        sha = tr.sha256_text(image.get("sha256"))
        dims = tr.dimensions(case)
        if not sha or dims is None:
            continue
        dims_by_case[sha] = dims
        collected: dict[int, list[np.ndarray]] = {}
        for annotation in tr.case_annotations(case, "width"):
            try:
                raw = tr.annotation_raw(annotation, dataset_path.parent)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            value = next((raw.get(key) for key in ("toothWidthsPx", "toothWidths") if key in raw), None)
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, dict):
                    continue
                number = tr.finite_float(item.get("toothNo"))
                pair = tr.width_pair(item)
                if number is None or pair is None or not 1 <= int(number) <= 12:
                    continue
                p1, p2 = pair
                if (p2[0], p2[1]) < (p1[0], p1[1]):
                    p1, p2 = p2, p1
                collected.setdefault(int(number), []).append(
                    tr.normalize_points([p1, p2], dims))
        if collected:
            per_case[sha] = {t: np.mean(np.stack(v), axis=0) for t, v in collected.items()}
    return per_case, dims_by_case


# ── 치아 단위 다단 KRR ───────────────────────────────────────────────────────

def fit_tooth_stages(x, baseline, target):
    """치아 하나(출력 4열)에 대한 다단 잔차 학습. `tr.fit_stages`와 같은 절차."""
    stages, current = [], baseline
    for gamma_factor, regularization in STAGE_HYPER:
        model = tr.fit_krr(x, current, target, gamma_factor, regularization)
        stages.append(model)
        current = tr.predict_krr(model, x, current, PER_STAGE)[0]
        current = tr.clip_cumulative(current, baseline, CUMULATIVE)
    return stages


def predict_tooth_stages(stages, x, baseline):
    prediction, accepted, _ = tr.predict_krr(stages[0], x, baseline, PER_STAGE)
    prediction = tr.clip_cumulative(prediction, baseline, CUMULATIVE)
    for model in stages[1:]:
        stepped = tr.predict_krr(model, x, prediction, PER_STAGE)[0]
        stepped[~accepted] = baseline[~accepted]
        prediction = tr.clip_cumulative(stepped, baseline, CUMULATIVE)
    return prediction, accepted


def apply_bias(points, bias=WIDTH_BIAS):
    out = points.copy()
    mid = (points[:, 0::2, :] + points[:, 1::2, :]) / 2.0
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def metrics(pred_px, truth_px, scale):
    mid_p = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    pos = np.linalg.norm(mid_p - mid_t, axis=2) * scale[:, None]
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "positionMm": float(pos.mean()),
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "terminalPositionMm": float(pos[:, TERMINAL_IDX].mean()),
        "lengthAbsMm": float(np.abs(pl - tl).mean()),
        "molarLengthAbsMm": float(np.abs(pl - tl)[:, MOLAR_IDX].mean()),
        "tzlAbsErrorMm": float(np.abs(pl.sum(axis=1) - tl.sum(axis=1)).mean()),
        "_pos": pos.mean(axis=1),
        "_molarPos": pos[:, MOLAR_IDX].mean(axis=1),
        "_terminalPos": pos[:, TERMINAL_IDX].mean(axis=1),
        "_len": np.abs(pl - tl).mean(axis=1),
        "_molarLen": np.abs(pl - tl)[:, MOLAR_IDX].mean(axis=1),
        "_tzl": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
        "_perTooth": pos,
    }


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, info = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    full_groups = width["groups"]
    dims = dims_by_group(dataset_path)

    per_case, _ = tooth_truth_by_case(dataset_path)

    # 전체 케이스의 baseline(규칙엔진 초안)과 특징을 확보한다. build_samples는 완전
    # 주석만 돌려주므로, 부분 주석 케이스용으로 같은 전처리를 다시 통과시킨다.
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    baseline_document = json.loads((HERE / "baseline_predictions_all.json").read_text(encoding="utf-8"))
    baseline_records = tr.records_from_baseline(baseline_document)
    by_sha = {tr.baseline_sha(item): item for item in baseline_records if tr.baseline_sha(item)}
    quality: Counter[str] = Counter()

    features: dict[str, np.ndarray] = {}
    drafts: dict[str, np.ndarray] = {}
    for case in tr.dataset_cases(document):
        image = case.get("image") if isinstance(case.get("image"), dict) else {}
        sha = tr.sha256_text(image.get("sha256"))
        record = by_sha.get(sha) if sha else None
        if not sha or record is None or str(record.get("status", "ok")).casefold() != "ok":
            continue
        base_dims = tr.dimensions(record)
        components = tr.baseline_components(record, quality)
        if base_dims is None or components is None:
            continue
        width_points, ez_points, centers = components
        features[sha] = tr.feature_vector(width_points, ez_points, centers, base_dims[0] / base_dims[1])
        drafts[sha] = width_points.reshape(-1)

    full_set = set(full_groups.tolist())
    partial = {sha: teeth for sha, teeth in per_case.items()
               if sha not in full_set and sha in features and len(teeth) >= 1}
    partial_shas = sorted(partial)
    partial_tooth_count = sum(len(v) for v in partial.values())
    coverage = Counter()
    for teeth in partial.values():
        for t in teeth:
            coverage[t] += 1

    inventory = {
        "fullyAnnotatedCasesUsedNow": len(full_set),
        "partiallyAnnotatedCasesDiscardedNow": len(partial_shas),
        "salvageableToothTruths": partial_tooth_count,
        "equivalentFullCases": round(partial_tooth_count / 12.0, 1),
        "toothCoverageAmongPartialCases": {str(t): coverage[t] for t in range(1, 13)},
        "ezSamplesUsedNow": int(tasks["ez"]["x"].shape[0]),
        "casesWithoutAnyEzTruth": int(info["labelQuality"]["counts"].get("casesWithoutUsableEzTruth", 0)),
    }

    # ── A/B 학습 ────────────────────────────────────────────────────────────
    x_full = width["x"]
    base_full = width["baseline"]
    target_full = width["target"]
    x_part = np.stack([features[s] for s in partial_shas]) if partial_shas else np.zeros((0, x_full.shape[1]))
    base_part = np.stack([drafts[s] for s in partial_shas]) if partial_shas else np.zeros((0, base_full.shape[1]))

    masks = tr.grouped_folds(full_groups, FOLDS, SEED)
    predictions = {"A": np.zeros_like(target_full), "B": np.zeros_like(target_full)}
    gate_reject = {"A": 0, "B": 0}

    for test in masks:
        train = ~test
        for tooth in range(12):
            cols = slice(4 * tooth, 4 * tooth + 4)
            rows_x = [x_full[train]]
            rows_b = [base_full[train][:, cols]]
            rows_t = [target_full[train][:, cols]]
            extra_x, extra_b, extra_t = [], [], []
            for index, sha in enumerate(partial_shas):
                truth = partial[sha].get(tooth + 1)
                if truth is None:
                    continue
                extra_x.append(x_part[index])
                extra_b.append(base_part[index][cols])
                extra_t.append(truth.reshape(-1))
            for arm in ("A", "B"):
                xs = np.concatenate(rows_x + ([np.stack(extra_x)] if arm == "B" and extra_x else []))
                bs = np.concatenate(rows_b + ([np.stack(extra_b)] if arm == "B" and extra_b else []))
                ts = np.concatenate(rows_t + ([np.stack(extra_t)] if arm == "B" and extra_t else []))
                stages = fit_tooth_stages(xs, bs, ts)
                pred, accepted = predict_tooth_stages(stages, x_full[test], base_full[test][:, cols])
                predictions[arm][np.where(test)[0][:, None], np.arange(4 * tooth, 4 * tooth + 4)[None, :]] = pred
                gate_reject[arm] += int((~accepted).sum())

    truth_px = to_pixels(target_full.reshape(-1, 24, 2), full_groups, dims)
    scale = truth_scale_px(truth_px)
    draft_px = apply_bias(to_pixels(base_full.reshape(-1, 24, 2), full_groups, dims))
    scored = {
        "ruleDraft": metrics(draft_px, truth_px, scale),
        "A": metrics(apply_bias(to_pixels(predictions["A"].reshape(-1, 24, 2), full_groups, dims)), truth_px, scale),
        "B": metrics(apply_bias(to_pixels(predictions["B"].reshape(-1, 24, 2), full_groups, dims)), truth_px, scale),
    }

    keys = ("position", "molarPosition", "terminalPosition", "lengthAbs", "molarLengthAbs", "tzlAbsError")
    series = {"position": "_pos", "molarPosition": "_molarPos", "terminalPosition": "_terminalPos",
              "lengthAbs": "_len", "molarLengthAbs": "_molarLen", "tzlAbsError": "_tzl"}
    comparison = {key: paired(scored["A"][series[key]], scored["B"][series[key]]) for key in keys}

    # 부분 라벨이 실제로 존재하는 치아(주로 11·12)에서 이득이 나오는지 치아별로 본다.
    per_tooth = []
    for tooth in range(12):
        gain = paired(scored["A"]["_perTooth"][:, tooth], scored["B"]["_perTooth"][:, tooth])
        per_tooth.append({
            "toothNo": tooth + 1,
            "addedTruths": coverage[tooth + 1],
            "positionMmA": float(scored["A"]["_perTooth"][:, tooth].mean()),
            "positionMmB": float(scored["B"]["_perTooth"][:, tooth].mean()),
            "improvementPct": gain["improvementPct"],
            "significant": gain["significant"],
        })

    any_gain = [k for k in keys if comparison[k]["significant"] and comparison[k]["improvementPct"] > 0]
    any_harm = [k for k in keys if comparison[k]["significant"] and comparison[k]["improvementPct"] < 0]

    report = {
        "schemaVersion": "more-labels-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("이미 확보된 정답 중 학습에 들어가지 않는 부분(치아 12개 미만 주석 케이스)의 "
                 "가치를 실측. 치아 단위 다단 KRR로 A(완전 주석만) vs B(A+부분 주석 치아)를 "
                 "비교한다. 평가는 양쪽 모두 완전 주석 케이스의 그룹 5-fold OOF 예측이며 "
                 "부분 주석 케이스는 train에만 들어간다. 하이퍼파라미터는 배포 모델 값으로 "
                 "고정해 차이를 학습 데이터로만 한정했다. 픽셀 등방 공간, mm는 정답 최외곽 "
                 "스팬=54mm, 짝지어 부트스트랩 5,000회, WIDTH_BIAS 1.013 적용."),
        "inventory": inventory,
        "variants": {name: {k: v for k, v in s.items() if not k.startswith("_")}
                     for name, s in scored.items()},
        "bVersusA": comparison,
        "perTooth": per_tooth,
        "gateRejections": gate_reject,
        "verdict": {
            "significantGains": any_gain,
            "significantRegressions": any_harm,
            "worthAdopting": bool(any_gain and not any_harm),
            "conclusion": (
                "부분 주석 라벨을 치아 단위로 살리면 실측 개선이 있다 — 라벨을 새로 받지 않고 "
                "학습량을 늘릴 수 있다."
                if any_gain and not any_harm else
                "부분 주석 라벨을 살려도 유의한 개선이 없다 — 이미 확보된 폭 정답은 사실상 "
                "소진 상태이며, 추가 이득은 다른 종류의 라벨(EZ)에서 와야 한다."),
        },
    }
    (HERE / "more_labels.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("inventory:", json.dumps(inventory, ensure_ascii=True, indent=1))
    print(f"\n{'variant':10s} {'pos':>7s} {'molarPos':>9s} {'termPos':>8s} {'lenAbs':>7s} {'tzl':>7s}")
    for name in ("ruleDraft", "A", "B"):
        s = scored[name]
        print(f"{name:10s} {s['positionMm']:7.3f} {s['molarPositionMm']:9.3f} "
              f"{s['terminalPositionMm']:8.3f} {s['lengthAbsMm']:7.4f} {s['tzlAbsErrorMm']:7.3f}")
    print("\nB vs A (paired bootstrap):")
    for key in keys:
        g = comparison[key]
        print(f"  {key:18s} {g['old']:.4f} -> {g['new']:.4f} ({g['improvementPct']:+6.2f}%) "
              f"CI [{g['ci95'][0]:+.4f},{g['ci95'][1]:+.4f}] sig={g['significant']}")
    print("\nper tooth (added truths / position mm A -> B):")
    for row in per_tooth:
        print(f"  tooth {row['toothNo']:2d}  +{row['addedTruths']:3d}  "
              f"{row['positionMmA']:6.3f} -> {row['positionMmB']:6.3f} "
              f"({row['improvementPct']:+6.2f}%) sig={row['significant']}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=1))


if __name__ == "__main__":
    main()
