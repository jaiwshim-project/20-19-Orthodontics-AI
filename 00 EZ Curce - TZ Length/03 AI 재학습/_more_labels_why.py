#!/usr/bin/env python3
"""부분 주석 라벨을 넣으면 왜 나빠지는가 — 원인 분리.

`_more_labels.py`에서 부분 주석 31건(치아 단위 319개)을 학습에 추가하면 위치가
−9.96% 악화됐다. 원인 후보는 둘이고 처방이 정반대다.

  H1 적합 교란: 행을 추가하면 표준화(mean/scale)와 gamma(중앙 거리 기반)와
      게이트 거리까지 같이 바뀐다. 정보가 나쁜 게 아니라 커널이 흔들린 것.
      → 처방: 표준화·gamma·게이트를 완전 주석 집합에서 고정하고 alpha만 재풀이.
  H2 라벨 불일치: 추가된 정답 자체가 다른 규약을 따른다. 특히 10개만 주석된
      케이스라면 **치아 번호가 밀려 있을** 수 있다(annotator가 1번을 다르게 셈).
      → 처방: 그 라벨은 쓰면 안 된다. 번호 정합을 사람이 확인해야 한다.

H2 판별법: 부분 주석 케이스의 치아 k 정답 폭이, 완전 주석 케이스의 치아 k 폭
분포보다 k±1 분포에 더 가까우면 번호 밀림이다. 폭은 mm(정답 최외곽 스팬 기준)로
비교하되, 부분 주석 케이스는 최외곽 치아가 없어 자기 스팬을 못 쓴다. 그래서
**해당 케이스에서 함께 주석된 치아들의 스팬**으로 정규화한 상대폭을 쓴다
(치아 1~10이 모두 있는 케이스만 비교 대상이라 공통 기준이 성립한다).

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np

import train_residual as tr
from _more_labels import (CUMULATIVE, PER_STAGE, SEED, STAGE_HYPER, WIDTH_BIAS,
                          apply_bias, metrics, tooth_truth_by_case)
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_px import paired

HERE = Path(__file__).resolve().parent
FOLDS = 5


def fit_frozen_stages(x_core, x_extra, baseline_core, baseline_extra, target_core, target_extra):
    """표준화·gamma·게이트는 core에서만 정하고, alpha 해에만 extra를 참여시킨다.

    이렇게 하면 커널 기하가 A와 동일해지므로 H1(적합 교란)을 제거한 상태로
    '추가 정답의 정보량'만 남는다. 프로토타입 집합은 core∪extra가 되어야
    추가 행이 해에 영향을 줄 수 있다 — 대신 표준화/gamma/게이트는 core 값을 쓴다.
    """
    mean, scale = tr.standardize_fit(x_core)
    core_p = (x_core - mean) / scale
    gamma = tr.gamma_base(core_p) * 0.0  # placeholder, 아래에서 단계별로 설정
    gate = tr.distance_gate(core_p)
    del gamma

    stages = []
    current_core, current_extra = baseline_core, baseline_extra
    for gamma_factor, regularization in STAGE_HYPER:
        gamma_value = tr.gamma_base(core_p) * gamma_factor
        x_all = np.concatenate([x_core, x_extra]) if len(x_extra) else x_core
        prototypes = (x_all - mean) / scale
        kernel = np.exp(-gamma_value * tr.squared_distances(prototypes, prototypes))
        target_all = np.concatenate([target_core, target_extra]) if len(x_extra) else target_core
        base_all = np.concatenate([current_core, current_extra]) if len(x_extra) else current_core
        alpha = tr.solve_alpha(kernel, target_all - base_all, regularization)
        model = {
            "featureMean": mean, "featureScale": scale, "prototypes": prototypes,
            "alpha": alpha, "gamma": float(gamma_value), "gammaFactor": float(gamma_factor),
            "lambda": float(regularization), "gateDistance": float(gate),
            "gateKernelSimilarity": float(np.exp(-gamma_value * gate * gate)),
        }
        stages.append(model)
        current_core = tr.clip_cumulative(
            tr.predict_krr(model, x_core, current_core, PER_STAGE)[0], baseline_core, CUMULATIVE)
        if len(x_extra):
            current_extra = tr.clip_cumulative(
                tr.predict_krr(model, x_extra, current_extra, PER_STAGE)[0], baseline_extra, CUMULATIVE)
    return stages


def predict(stages, x, baseline):
    prediction, accepted, _ = tr.predict_krr(stages[0], x, baseline, PER_STAGE)
    prediction = tr.clip_cumulative(prediction, baseline, CUMULATIVE)
    for model in stages[1:]:
        stepped = tr.predict_krr(model, x, prediction, PER_STAGE)[0]
        stepped[~accepted] = baseline[~accepted]
        prediction = tr.clip_cumulative(stepped, baseline, CUMULATIVE)
    return prediction


def relative_widths(points_by_tooth: dict[int, np.ndarray], teeth: list[int],
                    aspect: float) -> np.ndarray | None:
    """치아 1~10 상대폭. 스팬(치아 1 바깥 ~ 치아 10 바깥)으로 나눠 스케일을 제거.

    정규화 좌표는 종횡비만큼 왜곡되므로 x축을 aspect로 되돌려 등방으로 만든다
    ([[project-segment-position-bottleneck]]의 교훈).
    """
    if any(t not in points_by_tooth for t in teeth):
        return None
    iso = {t: points_by_tooth[t] * np.array([aspect, 1.0]) for t in teeth}
    widths = np.array([np.linalg.norm(iso[t][0] - iso[t][1]) for t in teeth])
    ends = np.concatenate([iso[teeth[0]], iso[teeth[-1]]])
    span = max(np.linalg.norm(a - b) for a in ends for b in ends)
    if span <= 0:
        return None
    return widths / span


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    full_groups = width["groups"]
    dims = dims_by_group(dataset_path)
    per_case, _ = tooth_truth_by_case(dataset_path)

    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    baseline_document = json.loads((HERE / "baseline_predictions_all.json").read_text(encoding="utf-8"))
    by_sha = {tr.baseline_sha(i): i for i in tr.records_from_baseline(baseline_document) if tr.baseline_sha(i)}
    quality: Counter[str] = Counter()
    features, drafts, aspects = {}, {}, {}
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
        w, e, c = components
        features[sha] = tr.feature_vector(w, e, c, base_dims[0] / base_dims[1])
        drafts[sha] = w.reshape(-1)
        aspects[sha] = base_dims[0] / base_dims[1]

    full_set = set(full_groups.tolist())
    partial_shas = sorted(s for s, teeth in per_case.items()
                          if s not in full_set and s in features and teeth)
    x_part = np.stack([features[s] for s in partial_shas])
    base_part = np.stack([drafts[s] for s in partial_shas])

    # ── H2: 치아 번호 밀림 진단 ─────────────────────────────────────────────
    teeth_1_10 = list(range(1, 11))
    full_rel, partial_rel = [], []
    for index, sha in enumerate(full_groups.tolist()):
        points = {t: width["target"][index].reshape(12, 2, 2)[t - 1] for t in range(1, 13)}
        row = relative_widths(points, teeth_1_10, aspects.get(sha, 1.0))
        if row is not None:
            full_rel.append(row)
    for sha in partial_shas:
        row = relative_widths(per_case[sha], teeth_1_10, aspects.get(sha, 1.0))
        if row is not None:
            partial_rel.append(row)
    full_rel = np.stack(full_rel)
    partial_rel = np.stack(partial_rel)
    full_mean, full_sd = full_rel.mean(axis=0), full_rel.std(axis=0) + 1e-12
    partial_mean = partial_rel.mean(axis=0)

    def misfit(shift: int) -> float:
        """치아 번호를 shift만큼 밀었다고 가정했을 때의 표준화 잔차(z) 평균 절대값."""
        errors = []
        for position in range(10):
            source = position + shift
            if 0 <= source < 10:
                errors.append(abs(partial_mean[position] - full_mean[source]) / full_sd[source])
        return float(np.mean(errors)) if errors else float("nan")

    shifts = {str(s): round(misfit(s), 3) for s in (-2, -1, 0, 1, 2)}
    best_shift = min(shifts, key=lambda k: shifts[k])

    # ── H1: 커널 기하를 고정한 채 정답만 추가 ───────────────────────────────
    masks = tr.grouped_folds(full_groups, FOLDS, SEED)
    pred = {"A": np.zeros_like(width["target"]), "C": np.zeros_like(width["target"])}
    for test in masks:
        train = ~test
        for tooth in range(12):
            cols = slice(4 * tooth, 4 * tooth + 4)
            xc, bc, tc = width["x"][train], width["baseline"][train][:, cols], width["target"][train][:, cols]
            keep = [i for i, s in enumerate(partial_shas) if (tooth + 1) in per_case[s]]
            xe = x_part[keep] if keep else np.zeros((0, xc.shape[1]))
            be = base_part[keep][:, cols] if keep else np.zeros((0, 4))
            te = (np.stack([per_case[partial_shas[i]][tooth + 1].reshape(-1) for i in keep])
                  if keep else np.zeros((0, 4)))
            empty = np.zeros((0, xc.shape[1])), np.zeros((0, 4)), np.zeros((0, 4))
            for arm, extra in (("A", empty), ("C", (xe, be, te))):
                stages = fit_frozen_stages(xc, extra[0], bc, extra[1], tc, extra[2])
                rows = np.where(test)[0][:, None]
                pred[arm][rows, np.arange(4 * tooth, 4 * tooth + 4)[None, :]] = predict(
                    stages, width["x"][test], width["baseline"][test][:, cols])

    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), full_groups, dims)
    scale = truth_scale_px(truth_px)
    scored = {name: metrics(apply_bias(to_pixels(values.reshape(-1, 24, 2), full_groups, dims)),
                            truth_px, scale) for name, values in pred.items()}
    keys = {"position": "_pos", "molarPosition": "_molarPos", "lengthAbs": "_len",
            "tzlAbsError": "_tzl"}
    comparison = {k: paired(scored["A"][s], scored["C"][s]) for k, s in keys.items()}

    h1_alive = any(v["significant"] and v["improvementPct"] > 0 for v in comparison.values())
    h1_harm = [k for k, v in comparison.items() if v["significant"] and v["improvementPct"] < 0]
    numbering_shifted = best_shift != "0"

    report = {
        "schemaVersion": "more-labels-why-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("부분 주석 라벨 추가가 악화를 낸 원인 분리. H1=적합 교란(표준화·gamma·게이트가 "
                 "행 추가로 흔들림), H2=라벨 규약 불일치(치아 번호 밀림). C는 커널 기하를 "
                 "완전 주석 집합에서 고정하고 alpha 해에만 추가 정답을 참여시킨 변형이다. "
                 "평가는 A와 동일한 그룹 5-fold OOF, 픽셀 등방, mm=최외곽 스팬 54mm."),
        "h2NumberingAlignment": {
            "comparableFullCases": int(full_rel.shape[0]),
            "comparablePartialCases": int(partial_rel.shape[0]),
            "meanAbsoluteZByAssumedShift": shifts,
            "bestShift": int(best_shift),
            "numberingLikelyShifted": numbering_shifted,
            "interpretation": ("치아 번호가 밀려 있다 — 이 라벨은 그대로 쓰면 안 된다."
                               if numbering_shifted else
                               "치아 번호는 정합한다 — 악화 원인은 번호 밀림이 아니다."),
        },
        "h1FrozenKernel": {
            "variants": {n: {k: v for k, v in s.items() if not k.startswith("_")}
                         for n, s in scored.items()},
            "cVersusA": comparison,
            "recoveredByFreezing": h1_alive and not h1_harm,
            "interpretation": ("커널 기하를 고정하면 추가 정답이 도움이 된다 — 악화는 적합 교란이었다."
                               if h1_alive and not h1_harm else
                               "커널 기하를 고정해도 도움이 없다 — 추가 정답 자체에 얻을 정보가 없다."),
        },
        "verdict": {
            "moreTrainingOnExistingWidthTruthHelps": bool(h1_alive and not h1_harm and not numbering_shifted),
        },
    }
    (HERE / "more_labels_why.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("H2 numbering: shifts(meanAbsZ) =", shifts, "best =", best_shift)
    print(f"   comparable full={full_rel.shape[0]} partial={partial_rel.shape[0]}")
    print("   full mean rel widths   :", np.round(full_mean, 4).tolist())
    print("   partial mean rel widths:", np.round(partial_mean, 4).tolist())
    print("\nH1 frozen kernel (A vs C):")
    for name in ("A", "C"):
        s = scored[name]
        print(f"   {name}  pos={s['positionMm']:.3f}  molar={s['molarPositionMm']:.3f} "
              f"lenAbs={s['lengthAbsMm']:.4f}  tzl={s['tzlAbsErrorMm']:.3f}")
    for key, gain in comparison.items():
        print(f"   {key:14s} {gain['old']:.4f} -> {gain['new']:.4f} ({gain['improvementPct']:+6.2f}%) "
              f"sig={gain['significant']}")
    print("\nverdict:", report["verdict"])


if __name__ == "__main__":
    main()
