#!/usr/bin/env python3
"""좌우 어금니 격차의 **메커니즘** — 왜 한쪽이 더 정확한가 (4차).

3차(`_molar_lr3.py`) 결과:
  · 좌우 규약은 384/384 일관 (치아1·2 = 영상 왼쪽)
  · **규칙엔진 초안은 좌우 대칭**(−2.83%, CI 0 포함, 무의미)
  · **KRR 보정 후 비대칭이 생긴다**: 위치 −8.01%, 길이 −11.26% (전부 시드 4/4 유의)
    (음수 = 오른쪽(치아11·12)이 더 정확)
  · 비대칭은 **클래스2 케이스에 집중**: class2 −13.36%(4/4 유의) vs 비클래스2 −1.07%(0/4)
  · 최외곽 치아에 집중(치아1 3.020 vs 치아12 2.817mm)

초안이 대칭인데 보정 후 비대칭이면, 원인은 **모델이 한쪽을 더 잘 배웠다**는 것이다.
왜 그런지 4개 가설을 실측으로 가른다.

  H1 **정답 자체가 비대칭**이다 — 클래스2에서 한쪽 어금니 폭이 계통적으로 더 크거나
     아치가 한쪽으로 치우쳐 있다. 그러면 모델은 실제 신호를 배운 것이고 "정확도 차이"가
     아니라 "난이도 차이"다.
  H2 **초안 오차의 방향(부호)이 좌우로 다르다** — 크기는 같아도 한쪽은 일관된 방향으로
     틀리고(=배우기 쉽다) 다른 쪽은 흩어진다(=배우기 어렵다). 학습 가능성의 차이.
     → 케이스 간 부호 일관성(|평균|/표준편차)으로 측정한다.
  H3 **촬영 회전**이 계통적이다 — 클래스2 코호트가 특정 방향으로 기울어 촬영되어
     한쪽이 아치 템플릿에 더 잘 맞는다.
  H4 **보정량 자체가 좌우로 다르다** — 캡(단계 5% / 누적 15%)에 한쪽만 걸려서
     충분히 못 고쳐진다. 그러면 원인은 데이터가 아니라 **캡**이다.

H2가 핵심 가설이다. 초안 크기는 대칭인데 보정 후 비대칭이라는 관측과 유일하게 정합한다.

mm는 정답 최외곽 스팬=54mm, 픽셀 등방. 출력에 PHI·좌표·파일명·담당자명 없음.
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

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEED = 20260711
BOOTSTRAP = 5000
WIDTH_BIAS = 1.013
LEFT = [0, 1]      # 치아 1·2 = 영상 왼쪽 (384/384 확인됨)
RIGHT = [10, 11]   # 치아 11·12 = 영상 오른쪽


def ci(values: np.ndarray, seed: int) -> list[float]:
    rng = np.random.default_rng(seed)
    n = len(values)
    means = [float(values[rng.integers(0, n, n)].mean()) for _ in range(BOOTSTRAP)]
    return [round(float(np.quantile(means, 0.025)), 4),
            round(float(np.quantile(means, 0.975)), 4)]


def signed_components(pred_px, truth_px):
    """선분 위치 오차를 아치 기준 방향으로 분해 + 길이 부호오차. 케이스×치아."""
    scale = truth_scale_px(truth_px)
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    mid_p = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    center = mid_t.mean(axis=1, keepdims=True)

    # 각 치아에서 아치 접선(이웃 중점 방향)과 그에 수직한 방향으로 분해
    along = np.zeros((len(truth_px), 12))
    inward = np.zeros((len(truth_px), 12))
    for t in range(12):
        prev_i, next_i = max(t - 1, 0), min(t + 1, 11)
        tangent = mid_t[:, next_i, :] - mid_t[:, prev_i, :]
        norm = np.linalg.norm(tangent, axis=1, keepdims=True)
        tangent = tangent / np.maximum(norm, 1e-9)
        normal = np.stack([-tangent[:, 1], tangent[:, 0]], axis=1)
        # normal이 아치 중심을 향하도록 부호 맞춤
        to_center = center[:, 0, :] - mid_t[:, t, :]
        sign = np.sign((normal * to_center).sum(axis=1))
        sign[sign == 0] = 1.0
        normal = normal * sign[:, None]
        delta = mid_p[:, t, :] - mid_t[:, t, :]
        along[:, t] = (delta * tangent).sum(axis=1) * scale
        inward[:, t] = (delta * normal).sum(axis=1) * scale

    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2) * scale[:, None]
    return {"along": along, "inward": inward, "lenSigned": pl - tl, "lenTruth": tl}


def consistency(values: np.ndarray) -> dict:
    """부호 일관성 = |평균| / 표준편차. 클수록 '한 방향으로 일관되게 틀린다' = 배우기 쉽다."""
    mean = float(values.mean())
    std = float(values.std())
    return {"meanMm": round(mean, 4),
            "stdMm": round(std, 4),
            "consistency": round(abs(mean) / max(std, 1e-9), 4),
            "sameSignFraction": round(float((np.sign(values) == np.sign(mean)).mean()), 3)}


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
    scale = truth_scale_px(truth_px)

    # ── H1: 정답 자체가 비대칭인가 ─────────────────────────────────────────────
    truth_len = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    h1 = {}
    for label, sel in (("all", np.ones(len(truth_px), bool)),
                       ("class2", is_class2), ("other", ~is_class2)):
        left_len = truth_len[sel][:, LEFT].mean(axis=1)
        right_len = truth_len[sel][:, RIGHT].mean(axis=1)
        delta = right_len - left_len
        h1[label] = {
            "cases": int(sel.sum()),
            "leftTruthLenMm": round(float(left_len.mean()), 4),
            "rightTruthLenMm": round(float(right_len.mean()), 4),
            "rightMinusLeftMm": round(float(delta.mean()), 4),
            "ci95": ci(delta, SEED),
            "significant": None,
        }
        low, high = h1[label]["ci95"]
        h1[label]["significant"] = bool(low > 0 or high < 0)

    # ── H3: 촬영 회전 — 양 최말단 어금니를 잇는 선의 기울기 ──────────────────────
    vector = mid_t[:, 11, :] - mid_t[:, 0, :]
    tilt_deg = np.degrees(np.arctan2(vector[:, 1], vector[:, 0]))
    h3 = {}
    for label, sel in (("class2", is_class2), ("other", ~is_class2)):
        values = tilt_deg[sel]
        h3[label] = {"cases": int(sel.sum()),
                     "meanTiltDeg": round(float(values.mean()), 3),
                     "stdTiltDeg": round(float(values.std()), 3),
                     "ci95": ci(values, SEED)}

    # ── H2 & H4: 초안 오차의 부호 일관성 / 보정량 ─────────────────────────────
    draft = signed_components(base_px, truth_px)
    h2_draft = {}
    for label, sel in (("all", np.ones(len(truth_px), bool)),
                       ("class2", is_class2), ("other", ~is_class2)):
        row = {}
        for side, idx in (("left", LEFT), ("right", RIGHT)):
            for comp in ("along", "inward", "lenSigned"):
                row[f"{side}_{comp}"] = consistency(draft[comp][sel][:, idx].mean(axis=1))
        h2_draft[label] = row

    # KRR OOF 예측 + 보정량
    prediction = np.zeros_like(target)
    for index, test_mask in enumerate(tr.grouped_folds(groups, FOLDS, SEED), start=1):
        train_mask = ~test_mask
        models = tr.fit_stages(x[train_mask], base[train_mask], target[train_mask],
                               STAGE_HYPER, PER_STAGE, CUMULATIVE)
        prediction[test_mask] = tr.predict_stages(
            models, x[test_mask], base[test_mask], PER_STAGE, CUMULATIVE)[0]
    pred_px = scale_about_midpoint(to_pixels(prediction.reshape(-1, 24, 2), groups, dims),
                                   WIDTH_BIAS)
    after = signed_components(pred_px, truth_px)

    # 보정량 = 초안 → 예측 중점 이동거리(mm). 캡에 걸리면 이 값이 상한 근처에 붙는다.
    mid_draft = (base_px[:, 0::2, :] + base_px[:, 1::2, :]) / 2.0
    mid_pred = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    moved = np.linalg.norm(mid_pred - mid_draft, axis=2) * scale[:, None]
    # 필요 이동량 = 초안이 정답까지 가야 하는 거리
    needed = np.linalg.norm(mid_t - mid_draft, axis=2) * scale[:, None]

    h4 = {}
    for label, sel in (("all", np.ones(len(truth_px), bool)),
                       ("class2", is_class2), ("other", ~is_class2)):
        row = {}
        for side, idx in (("left", LEFT), ("right", RIGHT)):
            m = moved[sel][:, idx].mean(axis=1)
            n = needed[sel][:, idx].mean(axis=1)
            row[side] = {
                "neededMoveMm": round(float(n.mean()), 4),
                "actualMoveMm": round(float(m.mean()), 4),
                "moveFraction": round(float((m / np.maximum(n, 1e-9)).mean()), 4),
            }
        row["fractionGapRightMinusLeft"] = round(
            row["right"]["moveFraction"] - row["left"]["moveFraction"], 4)
        h4[label] = row

    # 보정 후 잔차 일관성(무엇이 남았나)
    h2_after = {}
    for label, sel in (("all", np.ones(len(truth_px), bool)),
                       ("class2", is_class2), ("other", ~is_class2)):
        row = {}
        for side, idx in (("left", LEFT), ("right", RIGHT)):
            for comp in ("along", "inward", "lenSigned"):
                row[f"{side}_{comp}"] = consistency(after[comp][sel][:, idx].mean(axis=1))
        h2_after[label] = row

    report = {
        "schemaVersion": "molar-lr4-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("좌우 어금니 격차의 메커니즘. 왼쪽=치아1·2(영상 왼쪽), 오른쪽=치아11·12. "
                 "H1 정답 비대칭 / H2 초안 오차 부호 일관성(=학습 가능성) / "
                 "H3 촬영 회전 / H4 보정량·캡 포화. "
                 f"픽셀 등방 mm(스팬=54mm), 시드 {SEED}, 부트스트랩 {BOOTSTRAP}회. "
                 "consistency = |평균|/표준편차, 클수록 한 방향으로 일관되게 틀림 = 배우기 쉬움."),
        "h1TruthAsymmetry": h1,
        "h2DraftErrorConsistency": h2_draft,
        "h2ResidualAfterKrr": h2_after,
        "h3PhotoTilt": h3,
        "h4CorrectionAmount": h4,
    }
    (HERE / "molar_lr4.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("H1 - is the TRUTH itself asymmetric? (right minus left molar width)")
    for label, row in h1.items():
        print(f"   {label:8s} n={row['cases']:3d}  L {row['leftTruthLenMm']:.3f} "
              f"R {row['rightTruthLenMm']:.3f}  diff {row['rightMinusLeftMm']:+.3f}mm "
              f"ci {row['ci95']}  sig {row['significant']}")

    print("\nH3 - photo tilt (terminal-to-terminal line angle, deg)")
    for label, row in h3.items():
        print(f"   {label:8s} mean {row['meanTiltDeg']:+.2f} std {row['stdTiltDeg']:.2f} "
              f"ci {row['ci95']}")

    print("\nH2 - DRAFT error sign consistency (higher = easier to learn)")
    for label in ("all", "class2", "other"):
        print(f"  [{label}]")
        for comp in ("along", "inward", "lenSigned"):
            l = h2_draft[label][f"left_{comp}"]
            r = h2_draft[label][f"right_{comp}"]
            print(f"   {comp:10s} L mean {l['meanMm']:+.3f} std {l['stdMm']:.3f} "
                  f"cons {l['consistency']:.3f} | R mean {r['meanMm']:+.3f} "
                  f"std {r['stdMm']:.3f} cons {r['consistency']:.3f}")

    print("\nH4 - how much correction was actually applied")
    for label in ("all", "class2", "other"):
        row = h4[label]
        print(f"   {label:8s} L needed {row['left']['neededMoveMm']:.3f} "
              f"moved {row['left']['actualMoveMm']:.3f} frac {row['left']['moveFraction']:.3f}"
              f"  |  R needed {row['right']['neededMoveMm']:.3f} "
              f"moved {row['right']['actualMoveMm']:.3f} frac {row['right']['moveFraction']:.3f}"
              f"  | gap {row['fractionGapRightMinusLeft']:+.3f}")

    print("\nH2b - residual AFTER krr (what remains)")
    for label in ("all", "class2", "other"):
        print(f"  [{label}]")
        for comp in ("along", "inward", "lenSigned"):
            l = h2_after[label][f"left_{comp}"]
            r = h2_after[label][f"right_{comp}"]
            print(f"   {comp:10s} L mean {l['meanMm']:+.3f} std {l['stdMm']:.3f} "
                  f"| R mean {r['meanMm']:+.3f} std {r['stdMm']:.3f}")


if __name__ == "__main__":
    main()
