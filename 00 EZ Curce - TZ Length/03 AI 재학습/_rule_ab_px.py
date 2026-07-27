#!/usr/bin/env python3
"""규칙엔진 후보 A/B 짝지어진 실측 평가 — 픽셀 공간, 홀드아웃(root 83건).

`_rule_ab_eval.py`(정규화 공간, 잘못 교정한 prior)를 폐기하고 다시 한다.

후보:
  old  기준선 (운영 HTML 그대로)
  new  섹션28 1차안: prior=정규화공간 교정값 + 탐색범위 [0.72,1.28]  ← 측정오류 산물
  v1   prior x (정답/초안 폭 비율). 비율은 **root가 아닌 185건에서만** 산출하고
       평가는 root 83건에서 한다 → 홀드아웃
  v2   탐색 페널티 완화 (-.30|ratio-1| → -.15), prior 불변

평가 지표(전부 픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm):
  position(중점 이동), lengthAbs/lengthSigned, angle, coordMAE(정규화, 기존 정의 호환)
케이스 단위 짝지어진 부트스트랩 5,000회로 CI를 낸다.

정답 결합은 이미지 SHA-256 동일성만 사용(파일 번호 매칭 금지).
출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_eval import inject_sha

HERE = Path(__file__).resolve().parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
BOOTSTRAP = 5000
MOLAR_IDX = [0, 1, 10, 11]
CANDIDATES = (("old", "_cand_old.json"), ("new", "_cand_new.json"),
              ("v1", "_cand_v1.json"), ("v2", "_cand_v2.json"))


def load_px(json_name: str):
    src = HERE / json_name
    dst = HERE / f"_sha_{json_name}"
    inject_sha(src, dst)
    tasks, quality = tr.build_samples(HERE / "dataset-index.json", dst)
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    return groups, truth, draft, truth_scale_px(truth), width, quality


def components(draft: np.ndarray, truth: np.ndarray, scale: np.ndarray):
    out = {k: [] for k in ("position", "lenSigned", "lenTruth", "angle")}
    for t in range(12):
        a, b = 2 * t, 2 * t + 1
        t0, t1, d0, d1 = truth[:, a, :], truth[:, b, :], draft[:, a, :], draft[:, b, :]
        vec = t1 - t0
        tlen = np.linalg.norm(vec, axis=1)
        unit = vec / np.maximum(tlen[:, None], EPS)
        dvec = d1 - d0
        dlen = np.linalg.norm(dvec, axis=1)
        cos = np.clip((dvec * unit).sum(axis=1) / np.maximum(dlen, EPS), -1.0, 1.0)
        shift = (d0 + d1) / 2.0 - (t0 + t1) / 2.0
        out["position"].append(np.linalg.norm(shift, axis=1) * scale)
        out["lenSigned"].append((dlen - tlen) * scale)
        out["lenTruth"].append(tlen * scale)
        out["angle"].append(np.degrees(np.arccos(np.abs(cos))))
    return {k: np.stack(v, axis=1) for k, v in out.items()}


def coord_mae_norm(width, idx=None) -> np.ndarray:
    """정규화 좌표 MAE (기존 보고 지표와 동일 정의). 비교용으로만 유지."""
    delta = (width["baseline"] - width["target"]).reshape(len(width["target"]), 24, 2)
    if idx is not None:
        cols = [i for t in idx for i in (2 * t, 2 * t + 1)]
        delta = delta[:, cols, :]
    return np.abs(delta).reshape(len(delta), -1).mean(axis=1)


def paired(old_case: np.ndarray, new_case: np.ndarray, seed: int = SEED) -> dict:
    rng = np.random.default_rng(seed)
    n = len(old_case)
    diffs = np.array([(old_case[p].mean() - new_case[p].mean())
                      for p in (rng.integers(0, n, n) for _ in range(BOOTSTRAP))])
    lo, hi = np.quantile(diffs, [0.025, 0.975])
    return {
        "old": float(old_case.mean()), "new": float(new_case.mean()),
        "improvementPct": float((old_case.mean() - new_case.mean()) / max(abs(old_case.mean()), EPS) * 100),
        "ci95": [float(lo), float(hi)], "significant": bool(lo > 0 or hi < 0),
        "casesImproved": int((new_case < old_case).sum()),
        "casesWorsened": int((new_case > old_case).sum()),
    }


def main() -> None:
    loaded = {}
    for name, fname in CANDIDATES:
        loaded[name] = load_px(fname)
    base_groups = loaded["old"][0]
    for name in loaded:
        assert np.array_equal(loaded[name][0], base_groups), f"{name}: 케이스 집합 불일치"
        assert np.allclose(loaded[name][1], loaded["old"][1]), f"{name}: 정답 불일치"

    truth, scale = loaded["old"][1], loaded["old"][3]
    comp = {name: components(loaded[name][2], truth, scale) for name in loaded}

    report = {
        "schemaVersion": "rule-ab-px-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("규칙엔진 후보 4종의 짝지어진 실측 A/B. **픽셀 등방 공간**에서 측정하며 "
                 "v1의 prior 보정계수는 평가에 쓰지 않은 185건에서만 산출(홀드아웃). "
                 "정답 결합은 이미지 SHA-256만 사용. mm는 정답 최외곽 스팬=54mm 기준."),
        "pairedCases": int(len(truth)),
        "candidates": {
            "old": "운영 HTML 그대로",
            "new": "정규화공간 교정 prior + 탐색범위 [0.72,1.28] (측정오류 기반 1차안)",
            "v1": "prior x (정답/초안 폭 비율, 185건 홀드아웃 산출), 탐색범위 불변",
            "v2": "findWidthBoundary prior 페널티 -.30 -> -.15, prior 불변",
        },
        "absolute": {},
        "vsOld": {},
    }

    for name in loaded:
        c = comp[name]
        m = MOLAR_IDX
        report["absolute"][name] = {
            "molarPositionMm": float(c["position"][:, m].mean()),
            "allPositionMm": float(c["position"].mean()),
            "molarLengthAbsMm": float(np.abs(c["lenSigned"][:, m]).mean()),
            "allLengthAbsMm": float(np.abs(c["lenSigned"]).mean()),
            "allLengthSignedPct": float((c["lenSigned"] / np.maximum(c["lenTruth"], EPS)).mean() * 100),
            "molarLengthSignedPct": float((c["lenSigned"][:, m] / np.maximum(c["lenTruth"][:, m], EPS)).mean() * 100),
            "allAngleDeg": float(c["angle"].mean()),
            "molarCoordMaeNorm": float(coord_mae_norm(loaded[name][4], MOLAR_IDX).mean()),
            "allCoordMaeNorm": float(coord_mae_norm(loaded[name][4]).mean()),
        }

    o = comp["old"]
    for name in ("new", "v1", "v2"):
        c = comp[name]
        m = MOLAR_IDX
        report["vsOld"][name] = {
            "molarPosition": paired(o["position"][:, m].mean(axis=1), c["position"][:, m].mean(axis=1)),
            "allPosition": paired(o["position"].mean(axis=1), c["position"].mean(axis=1)),
            "molarLengthAbs": paired(np.abs(o["lenSigned"][:, m]).mean(axis=1),
                                     np.abs(c["lenSigned"][:, m]).mean(axis=1)),
            "allLengthAbs": paired(np.abs(o["lenSigned"]).mean(axis=1), np.abs(c["lenSigned"]).mean(axis=1)),
            "molarCoordMaeNorm": paired(coord_mae_norm(loaded["old"][4], MOLAR_IDX),
                                        coord_mae_norm(loaded[name][4], MOLAR_IDX)),
            "allCoordMaeNorm": paired(coord_mae_norm(loaded["old"][4]), coord_mae_norm(loaded[name][4])),
        }

    def promote(name: str) -> bool:
        v = report["vsOld"][name]
        return (v["allLengthAbs"]["ci95"][0] > 0 or v["allPosition"]["ci95"][0] > 0) and \
            v["allPosition"]["ci95"][1] > -EPS and v["allLengthAbs"]["new"] <= v["allLengthAbs"]["old"]

    decisions = {}
    for name in ("new", "v1", "v2"):
        v = report["vsOld"][name]
        pos_ok = v["allPosition"]["ci95"][0] > 0
        len_ok = v["allLengthAbs"]["ci95"][0] > 0
        no_harm = v["allPosition"]["new"] <= v["allPosition"]["old"] * 1.0 + EPS and \
            v["allLengthAbs"]["new"] <= v["allLengthAbs"]["old"] + EPS
        decisions[name] = {
            "positionSignificantlyBetter": bool(pos_ok),
            "lengthSignificantlyBetter": bool(len_ok),
            "noMetricWorsened": bool(no_harm),
            "decision": "promote" if ((pos_ok or len_ok) and no_harm) else "revert",
        }
    report["decisions"] = decisions
    promotable = [n for n, d in decisions.items() if d["decision"] == "promote"]
    report["finalVerdict"] = {
        "promotable": promotable,
        "recommended": (max(promotable, key=lambda n: report["vsOld"][n]["allPosition"]["improvementPct"])
                        if promotable else None),
        "rationale": ("승격 조건: 위치 또는 길이 오차가 통계적으로 유의하게 개선되고 "
                      "다른 지표가 악화되지 않을 때. 하나도 만족하지 못하면 운영 HTML 불변 유지."),
    }

    (HERE / "rule_ab_px.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"paired cases {report['pairedCases']} (픽셀 공간)")
    print(f"{'cand':5s} {'molarPos':>9s} {'allPos':>8s} {'molarLenAbs':>12s} {'allLenAbs':>10s} "
          f"{'allLenSign%':>11s} {'allAngle':>9s} {'molarMAE':>9s}")
    for name, _ in CANDIDATES:
        a = report["absolute"][name]
        print(f"{name:5s} {a['molarPositionMm']:9.3f} {a['allPositionMm']:8.3f} "
              f"{a['molarLengthAbsMm']:12.3f} {a['allLengthAbsMm']:10.3f} "
              f"{a['allLengthSignedPct']:11.1f} {a['allAngleDeg']:9.2f} {a['molarCoordMaeNorm']:9.6f}")
    for name in ("new", "v1", "v2"):
        print(f"\n[{name} vs old]")
        for key in ("allPosition", "molarPosition", "allLengthAbs", "molarLengthAbs",
                    "allCoordMaeNorm", "molarCoordMaeNorm"):
            v = report["vsOld"][name][key]
            print(f"  {key:18s} {v['old']:.5f} -> {v['new']:.5f} ({v['improvementPct']:+6.2f}%) "
                  f"CI [{v['ci95'][0]:+.5f},{v['ci95'][1]:+.5f}] sig={v['significant']} "
                  f"better/worse {v['casesImproved']}/{v['casesWorsened']}")
        print("  decision:", decisions[name]["decision"])
    print("\nfinalVerdict:", json.dumps(report["finalVerdict"], ensure_ascii=False))


if __name__ == "__main__":
    main()
