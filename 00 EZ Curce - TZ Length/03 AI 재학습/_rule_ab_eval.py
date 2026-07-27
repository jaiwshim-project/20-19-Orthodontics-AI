#!/usr/bin/env python3
"""규칙엔진 수정 A/B 짝지어진 실측 평가 (구 prior/범위 vs 신 prior/범위).

섹션28에서 밝힌 근본 원인 두 가지를 실제 엔진에 적용해 같은 이미지 119장을
두 사본에 통과시킨 결과를 정답과 맞춰 비교한다.

  구(_cand_rule_old.html) : AUTO_TOOTH_WIDTHS_MM 원본, ratio = .74 + .46k/24
  신(_cand_rule_new.html) : prior 재교정,             ratio = .72 + .56k/24

**학습 없음.** 규칙엔진 초안 자체를 정답과 직접 비교하므로 in-sample/OOF 구분이
필요 없다(단, prior는 정답 평균에서 유도했으므로 prior 자체는 전체 정답을 본
전역 상수 12개다 — 이 점은 `_calibrate_prior.py`의 폴드별 안정성 검증
(폴드 표준편차 <=0.45%)으로 과적합이 아님을 확인했다).

**정답 결합은 이미지 SHA-256 동일성만으로 한다.** 하네스 출력에는 imageRef가
비어 있으므로(root 소스), 여기서 루트 JPG를 직접 해싱해 imageRef를 주입한 뒤
`train_residual.build_samples`의 SHA 매칭 경로를 태운다. 파일 번호 매칭은 쓰지 않는다.

오차 분해(섹션28과 동일 규약):
  along = 정답 선분 방향 성분, perp = 법선 성분, position = 중점 이동 크기
  inward = 아치 중앙을 향하는 성분(>0이면 안쪽으로 밀림)
  coherence = |평균 벡터| / 평균 |벡터|  (1=항상 같은 방향, 0=랜덤 산포)

출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
SCALE_MM = 54.0
EPS = 1e-12
SEED = tr.DEFAULT_SEED
BOOTSTRAP = 5000
MOLAR_TEETH = (1, 2, 11, 12)  # 1-based
OLD_PRIOR = (12.19, 7.92, 8.13, 7.30, 6.49, 5.91, 5.91, 6.46, 7.21, 8.15, 8.04, 12.31)
NEW_PRIOR = (14.92, 9.46, 9.44, 8.14, 6.17, 5.32, 5.33, 6.10, 7.86, 9.27, 9.37, 14.74)
OLD_RATIO = (0.74, 1.20)
NEW_RATIO = (0.72, 1.28)


def inject_sha(src: Path, dst: Path) -> int:
    """루트 JPG를 해싱해 imageRef를 주입한다(정답 결합은 SHA로만)."""
    doc = json.loads(src.read_text(encoding="utf-8"))
    cache: dict[str, str] = {}
    filled = 0
    for record in doc.get("results", []):
        name = record.get("imageFile")
        if not name:
            continue
        if name not in cache:
            path = PROJECT / name
            if not path.exists():
                continue
            cache[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        record["imageRef"] = f"sha256:{cache[name]}"
        filled += 1
    dst.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return filled


def load(baseline_path: Path):
    tasks, quality = tr.build_samples(HERE / "dataset-index.json", baseline_path)
    width = tasks["width"]
    return width["baseline"], width["target"], width["groups"], quality


def truth_scale(target: np.ndarray) -> np.ndarray:
    pt = target.reshape(len(target), 24, 2)
    scale = np.zeros(len(target))
    for k in range(len(target)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale[k] = SCALE_MM / span if span > 0 else 0.0
    return scale


def decompose(base: np.ndarray, target: np.ndarray, scale: np.ndarray, teeth):
    """치아 집합에 대한 (케이스x치아) 성분 배열들."""
    pb, pt = base.reshape(len(base), 24, 2), target.reshape(len(target), 24, 2)
    midpoints = (pt[:, 0::2, :] + pt[:, 1::2, :]) / 2.0
    arch_center = midpoints.mean(axis=1)
    out = {k: [] for k in ("along", "perp", "position", "inward", "lenSigned", "angle", "truthLen")}
    for t in teeth:
        a, b = 2 * (t - 1), 2 * (t - 1) + 1
        t0, t1, b0, b1 = pt[:, a, :], pt[:, b, :], pb[:, a, :], pb[:, b, :]
        vec = t1 - t0
        tlen = np.linalg.norm(vec, axis=1)
        unit = vec / np.maximum(tlen[:, None], EPS)
        normal = np.stack((-unit[:, 1], unit[:, 0]), axis=1)
        shift = (b0 + b1) / 2.0 - (t0 + t1) / 2.0
        along = (shift * unit).sum(axis=1) * scale
        perp = (shift * normal).sum(axis=1) * scale
        to_center = arch_center - (t0 + t1) / 2.0
        inward_unit = to_center / np.maximum(np.linalg.norm(to_center, axis=1)[:, None], EPS)
        bvec = b1 - b0
        blen = np.linalg.norm(bvec, axis=1)
        cos = np.clip((bvec * unit).sum(axis=1) / np.maximum(blen, EPS), -1.0, 1.0)
        out["along"].append(along)
        out["perp"].append(perp)
        out["position"].append(np.hypot(along, perp))
        out["inward"].append((shift * inward_unit).sum(axis=1) * scale)
        out["lenSigned"].append((blen - tlen) * scale)
        out["angle"].append(np.degrees(np.arccos(np.abs(cos))))
        out["truthLen"].append(tlen * scale)
    return {k: np.stack(v, axis=1) for k, v in out.items()}  # (cases, teeth)


def summarize(d) -> dict:
    along, perp = d["along"].ravel(), d["perp"].ravel()
    mag = d["position"].ravel()
    return {
        "positionShiftMm": float(mag.mean()),
        "positionShiftP95Mm": float(np.quantile(mag, 0.95)),
        "lengthAbsErrorMm": float(np.abs(d["lenSigned"]).mean()),
        "lengthSignedErrorMm": float(d["lenSigned"].mean()),
        "angleDeg": float(d["angle"].mean()),
        "alongAbsMm": float(np.abs(along).mean()),
        "perpAbsMm": float(np.abs(perp).mean()),
        "inwardSignedMm": float(d["inward"].mean()),
        "coherence": float(np.hypot(along.mean(), perp.mean()) / max(mag.mean(), EPS)),
        "positionOverLengthRatio": float(mag.mean() / max(np.abs(d["lenSigned"]).mean(), EPS)),
        "shiftAsPctOfToothWidth": float((d["position"] / np.maximum(d["truthLen"], EPS)).mean() * 100),
        "casesShiftedOverQuarterPct": float((d["position"] > d["truthLen"] * 0.25).mean() * 100),
    }


def coord_mae(base: np.ndarray, target: np.ndarray, teeth=None) -> np.ndarray:
    """케이스별 좌표 MAE(정규화 좌표 기준, train_residual과 동일 정의)."""
    delta = (base - target).reshape(len(base), 24, 2)
    if teeth is not None:
        idx = [i for t in teeth for i in (2 * (t - 1), 2 * (t - 1) + 1)]
        delta = delta[:, idx, :]
    return np.abs(delta).reshape(len(base), -1).mean(axis=1)


def paired_bootstrap(old_case: np.ndarray, new_case: np.ndarray, seed: int = SEED) -> dict:
    rng = np.random.default_rng(seed)
    n = len(old_case)
    diffs = np.empty(BOOTSTRAP)
    for b in range(BOOTSTRAP):
        pick = rng.integers(0, n, n)
        diffs[b] = old_case[pick].mean() - new_case[pick].mean()
    lo, hi = np.quantile(diffs, [0.025, 0.975])
    return {
        "meanOld": float(old_case.mean()),
        "meanNew": float(new_case.mean()),
        "improvementPct": float((old_case.mean() - new_case.mean()) / max(old_case.mean(), EPS) * 100),
        "diffCi95": [float(lo), float(hi)],
        "pTwoSidedApprox": float(2 * min((diffs <= 0).mean(), (diffs >= 0).mean())),
        "significant": bool(lo > 0 or hi < 0),
    }


def unreachable(widths_mm: np.ndarray, prior, ratio) -> list[float]:
    lo, hi = ratio
    return [float((((widths_mm[:, t] > prior[t] * hi) | (widths_mm[:, t] < prior[t] * lo)).mean()) * 100)
            for t in range(12)]


def main() -> None:
    old_src, new_src = HERE / "_cand_old.json", HERE / "_cand_new.json"
    old_path, new_path = HERE / "_cand_old_sha.json", HERE / "_cand_new_sha.json"
    filled_old, filled_new = inject_sha(old_src, old_path), inject_sha(new_src, new_path)

    base_old, target_old, groups_old, q_old = load(old_path)
    base_new, target_new, groups_new, q_new = load(new_path)
    assert np.array_equal(groups_old, groups_new), "짝지어지지 않은 케이스 집합"
    assert np.allclose(target_old, target_new), "정답이 다르다 — 결합 오류"
    target, scale = target_old, truth_scale(target_old)
    all_teeth = tuple(range(1, 13))

    truth_widths = np.stack([
        np.linalg.norm(target.reshape(-1, 24, 2)[:, 2 * t, :] - target.reshape(-1, 24, 2)[:, 2 * t + 1, :], axis=1) * scale
        for t in range(12)], axis=1)

    result = {
        "schemaVersion": "rule-ab-eval-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("규칙엔진 prior 재교정 + 탐색범위 확대의 짝지어진 실측 A/B. 같은 이미지 119장을 "
                 "두 HTML 사본에 통과시킨 초안을 정답과 직접 비교(학습 없음). "
                 "정답 결합은 이미지 SHA-256 동일성만 사용. mm는 정답 최외곽 스팬=54mm 기준."),
        "changes": {
            "priorOld": list(OLD_PRIOR), "priorNew": list(NEW_PRIOR),
            "ratioOld": list(OLD_RATIO), "ratioNew": list(NEW_RATIO),
        },
        "matching": {"shaInjectedOld": filled_old, "shaInjectedNew": filled_new,
                     "pairedWidthCases": int(len(target)),
                     "casesWithoutBaselineOld": int(q_old.get("casesWithoutBaseline", 0))},
    }

    for scope, teeth in (("molar", MOLAR_TEETH), ("allTeeth", all_teeth)):
        d_old = decompose(base_old, target, scale, teeth)
        d_new = decompose(base_new, target, scale, teeth)
        block = {"old": summarize(d_old), "new": summarize(d_new)}
        for key in ("positionShiftMm", "lengthAbsErrorMm", "angleDeg", "inwardSignedMm"):
            o, n = block["old"][key], block["new"][key]
            block[f"{key}_changePct"] = round(float((abs(o) - abs(n)) / max(abs(o), EPS) * 100), 2)
        # 케이스 단위 짝지어진 부트스트랩
        block["positionBootstrap"] = paired_bootstrap(
            d_old["position"].mean(axis=1), d_new["position"].mean(axis=1))
        block["lengthAbsBootstrap"] = paired_bootstrap(
            np.abs(d_old["lenSigned"]).mean(axis=1), np.abs(d_new["lenSigned"]).mean(axis=1))
        block["coordMaeBootstrap"] = paired_bootstrap(
            coord_mae(base_old, target, teeth), coord_mae(base_new, target, teeth))
        result[scope] = block

    # 치아별
    d_old_all = decompose(base_old, target, scale, all_teeth)
    d_new_all = decompose(base_new, target, scale, all_teeth)
    result["perTooth"] = [{
        "tooth": t + 1,
        "oldPositionMm": round(float(d_old_all["position"][:, t].mean()), 3),
        "newPositionMm": round(float(d_new_all["position"][:, t].mean()), 3),
        "positionChangePct": round(float((d_old_all["position"][:, t].mean() - d_new_all["position"][:, t].mean())
                                         / max(d_old_all["position"][:, t].mean(), EPS) * 100), 1),
        "oldInwardMm": round(float(d_old_all["inward"][:, t].mean()), 3),
        "newInwardMm": round(float(d_new_all["inward"][:, t].mean()), 3),
        "oldLengthSignedMm": round(float(d_old_all["lenSigned"][:, t].mean()), 3),
        "newLengthSignedMm": round(float(d_new_all["lenSigned"][:, t].mean()), 3),
        "oldUnreachablePct": round(unreachable(truth_widths, OLD_PRIOR, OLD_RATIO)[t], 1),
        "newUnreachablePct": round(unreachable(truth_widths, NEW_PRIOR, NEW_RATIO)[t], 1),
    } for t in range(12)]

    molar_old = coord_mae(base_old, target, MOLAR_TEETH)
    molar_new = coord_mae(base_new, target, MOLAR_TEETH)
    pos_old = d_old_all["position"][:, [t - 1 for t in MOLAR_TEETH]].mean(axis=1)
    pos_new = d_new_all["position"][:, [t - 1 for t in MOLAR_TEETH]].mean(axis=1)
    result["verdict"] = {
        "molarPositionImprovedPct": round(float((pos_old.mean() - pos_new.mean()) / pos_old.mean() * 100), 2),
        "molarCoordMaeImprovedPct": round(float((molar_old.mean() - molar_new.mean()) / molar_old.mean() * 100), 2),
        "casesMolarPositionImproved": int((pos_new < pos_old).sum()),
        "casesMolarPositionWorsened": int((pos_new > pos_old).sum()),
        "decision": None,
    }
    pos_ci = result["molar"]["positionBootstrap"]["diffCi95"]
    all_ci = result["allTeeth"]["positionBootstrap"]["diffCi95"]
    improved = pos_ci[0] > 0 and result["allTeeth"]["positionBootstrap"]["meanNew"] <= \
        result["allTeeth"]["positionBootstrap"]["meanOld"]
    result["verdict"]["decision"] = "promote" if improved else "revert"
    result["verdict"]["rationale"] = (
        f"어금니 위치오차 개선 CI95 {pos_ci}, 전체 치아 위치오차 CI95 {all_ci}. "
        "승격 조건: 어금니 위치오차 개선이 통계적으로 유의하고 전체 치아가 악화되지 않을 때.")

    (HERE / "rule_ab_eval.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"paired width cases: {len(target)}")
    for scope in ("molar", "allTeeth"):
        b = result[scope]
        print(f"\n[{scope}]")
        print(f"  position  {b['old']['positionShiftMm']:.4f} -> {b['new']['positionShiftMm']:.4f} mm "
              f"({b['positionShiftMm_changePct']:+.2f}%)  CI {b['positionBootstrap']['diffCi95']}")
        print(f"  lengthAbs {b['old']['lengthAbsErrorMm']:.4f} -> {b['new']['lengthAbsErrorMm']:.4f} mm "
              f"({b['lengthAbsErrorMm_changePct']:+.2f}%)")
        print(f"  inward    {b['old']['inwardSignedMm']:+.3f} -> {b['new']['inwardSignedMm']:+.3f} mm  "
              f"coherence {b['old']['coherence']:.3f} -> {b['new']['coherence']:.3f}")
        print(f"  coordMAE  {b['coordMaeBootstrap']['meanOld']:.6f} -> {b['coordMaeBootstrap']['meanNew']:.6f} "
              f"({b['coordMaeBootstrap']['improvementPct']:+.2f}%) sig={b['coordMaeBootstrap']['significant']}")
    print("\ntooth  oldPos  newPos   chg%   oldInward newInward  oldUnreach newUnreach")
    for r in result["perTooth"]:
        print(f"{r['tooth']:5d} {r['oldPositionMm']:7.3f} {r['newPositionMm']:7.3f} {r['positionChangePct']:6.1f} "
              f"{r['oldInwardMm']:10.3f} {r['newInwardMm']:9.3f} {r['oldUnreachablePct']:11.1f} {r['newUnreachablePct']:10.1f}")
    print("\nverdict:", json.dumps(result["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
