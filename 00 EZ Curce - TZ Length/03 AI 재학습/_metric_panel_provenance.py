#!/usr/bin/env python3
"""오른쪽 '측정 결과' 패널 수치의 출처 판정 — 사용자가 본 값과 정답을 직접 대조.

사용자 화면: EZL 83.4 / px/mm 51.76 / 좌표 12·12·12 / TZL 87.9 / 차이 -4.5

질문: 이것은 측정(자동분석)인가 정답인가?

코드 사실(먼저 확정):
  · 측정 결과 패널은 calculateEZL()이 갱신하고, 이 함수는 전역 ezPoints/toothWidths를
    읽는다 — 하단 상세 수치와 **같은 상태**다. 별도 출처가 아니다.
  · showTruth()는 정답 좌표를 전역 상태에 **써넣고** calculateEZL()을 호출한다.
    → `✔ 정답 확인`을 누른 뒤에는 측정 결과 패널도 **정답**이 된다.
  · applyAutoDraft()도 같은 전역에 자동 좌표를 써넣고 calculateEZL()을 호출한다.
    → 자동분석만 돌렸으면 측정 결과 패널은 **자동분석 값**이다.

그래서 화면 숫자만으로는 구분이 안 된다. 대신 **룩업 442건 전체와 대조**해서
사용자가 본 조합(EZL 83.4 / TZL 87.9 / px/mm 51.76)이 어떤 정답 레코드와
일치하는지 센다. 일치하는 정답이 있으면 그 수치는 정답이다.

⚠️ 출력에 SHA·파일명·좌표·경로 없음. 케이스는 익명 순번으로만 표기한다.
"""
from __future__ import annotations

import io
import json
import math
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"

# 사용자가 화면에서 읽은 값
SEEN = {"ezl": 83.4, "pxPerMm": 51.76, "tzl": 87.9, "difference": -4.5,
        "toothCount": 12, "ezCount": 12, "widthCount": 12}
MOLAR_MM = 54.0
TOLERANCE_MM = 0.05  # 화면은 소수 1자리 → 0.05mm 이내면 같은 값


def truth_lookup() -> dict:
    text = RESEARCH.read_text(encoding="utf-8")
    marker = "window.TRUTH_LOOKUP="
    start = text.index(marker) + len(marker)
    end = text.index("\n", start)
    return json.loads(re.sub(r";\s*$", "", text[start:end]))


# --- 앱의 곡선 계산을 그대로 옮긴다(generateCurve / curveLength / correctedCurveLength) ---
def catmull_rom(points: list[dict], samples: int = 25) -> list[dict]:
    """generateCurve와 동일: Catmull-Rom 스플라인(앱은 j/25로 25분할)."""
    if len(points) < 2:
        return list(points)
    curve: list[dict] = []
    for i in range(len(points) - 1):
        p0 = points[i - 1] if i > 0 else points[i]
        p1, p2 = points[i], points[i + 1]
        p3 = points[i + 2] if i + 2 < len(points) else p2
        for s in range(samples):
            t = s / samples
            t2, t3 = t * t, t * t * t
            curve.append({
                "x": 0.5 * ((2 * p1["x"]) + (-p0["x"] + p2["x"]) * t
                            + (2 * p0["x"] - 5 * p1["x"] + 4 * p2["x"] - p3["x"]) * t2
                            + (-p0["x"] + 3 * p1["x"] - 3 * p2["x"] + p3["x"]) * t3),
                "y": 0.5 * ((2 * p1["y"]) + (-p0["y"] + p2["y"]) * t
                            + (2 * p0["y"] - 5 * p1["y"] + 4 * p2["y"] - p3["y"]) * t2
                            + (-p0["y"] + 3 * p1["y"] - 3 * p2["y"] + p3["y"]) * t3),
            })
    curve.append(points[-1])
    return curve


def polyline_length(pts: list[dict]) -> float:
    return sum(math.hypot(pts[i]["x"] - pts[i - 1]["x"], pts[i]["y"] - pts[i - 1]["y"])
               for i in range(1, len(pts)))


def cumulative(curve: list[dict]) -> list[float]:
    """densifyWithCum과 동일."""
    cum = [0.0]
    for i in range(1, len(curve)):
        cum.append(cum[i - 1] + math.hypot(curve[i]["x"] - curve[i - 1]["x"],
                                          curve[i]["y"] - curve[i - 1]["y"]))
    return cum


def project_arc(point: dict, curve: list[dict], cum: list[float]) -> float:
    """projectArc와 동일: 점을 곡선에 투영한 호 위치(px)."""
    best, best_arc = float("inf"), 0.0
    for i in range(1, len(curve)):
        a, b = curve[i - 1], curve[i]
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        l2 = dx * dx + dy * dy
        t = ((point["x"] - a["x"]) * dx + (point["y"] - a["y"]) * dy) / l2 if l2 > 0 else 0.0
        t = max(0.0, min(1.0, t))
        px, py = a["x"] + dx * t, a["y"] + dy * t
        dd = (point["x"] - px) ** 2 + (point["y"] - py) ** 2
        if dd < best:
            best, best_arc = dd, cum[i - 1] + math.sqrt(l2) * t
    return best_arc


def corrected_curve_length(curve: list[dict], widths: list[dict]) -> float | None:
    """correctedCurveLength와 동일: 치아가 점유하는 호 구간만 union 합산."""
    valid = [w for w in (widths or []) if w and w.get("p1") and w.get("p2")]
    if len(curve) < 2 or not valid:
        return None
    cum = cumulative(curve)
    segs = sorted(
        (lambda a, b: (min(a, b), max(a, b)))(
            project_arc(w["p1"], curve, cum), project_arc(w["p2"], curve, cum))
        for w in valid)
    union, cur_s, cur_e = 0.0, segs[0][0], segs[0][1]
    for start, end in segs[1:]:
        if start <= cur_e:
            cur_e = max(cur_e, end)
        else:
            union += cur_e - cur_s
            cur_s, cur_e = start, end
    return union + cur_e - cur_s


def main() -> None:
    lookup = truth_lookup()
    print(f"룩업 항목: {len(lookup)}건")
    print(f"화면에서 본 값: EZL {SEEN['ezl']} / px/mm {SEEN['pxPerMm']} / TZL {SEEN['tzl']}"
          f" / 차이 {SEEN['difference']}")
    print()

    ez_matches, tzl_matches, both_matches, scale_matches = [], [], [], []
    for index, record in enumerate(sorted(lookup.values(), key=lambda r: str(r.get("id")))):
        ez = record.get("ezPoints") or []
        widths = record.get("toothWidths") or []
        if len(ez) < 2 or not widths:
            continue
        # px/mm = EZ 양 끝점 거리 / molarMm (앱 calculateEZL과 동일)
        molar_px = math.hypot(ez[-1]["x"] - ez[0]["x"], ez[-1]["y"] - ez[0]["y"])
        if molar_px <= 0:
            continue
        px_per_mm = molar_px / MOLAR_MM
        tzl = sum(math.hypot(w["p2"]["x"] - w["p1"]["x"], w["p2"]["y"] - w["p1"]["y"])
                  for w in widths) / px_per_mm
        curve = catmull_rom(ez)
        ezl_full = polyline_length(curve) / px_per_mm
        # 앱 calculateEZL은 폭선이 있으면 **보정 EZL**(치아 점유 호 구간)을 쓴다.
        corrected_px = corrected_curve_length(curve, widths)
        ezl_app = (corrected_px / px_per_mm) if corrected_px is not None else ezl_full

        ez_hit = abs(ezl_app - SEEN["ezl"]) <= TOLERANCE_MM
        tzl_hit = abs(tzl - SEEN["tzl"]) <= TOLERANCE_MM
        scale_hit = abs(px_per_mm - SEEN["pxPerMm"]) <= 0.005
        row = {"cohortIndex": index, "ezlCorrectedMm": round(ezl_app, 2),
               "ezlFullCurveMm": round(ezl_full, 2),
               "tzlMm": round(tzl, 2), "pxPerMm": round(px_per_mm, 2),
               "differenceMm": round(ezl_app - tzl, 2),
               "ezCount": len(ez), "widthCount": len(widths)}
        if ez_hit:
            ez_matches.append(row)
        if tzl_hit:
            tzl_matches.append(row)
        if scale_hit:
            scale_matches.append(row)
        if tzl_hit and scale_hit:
            both_matches.append(row)

    triple = [r for r in both_matches if abs(r["ezlCorrectedMm"] - SEEN["ezl"]) <= TOLERANCE_MM]

    print(f"정답 TZL이 {SEEN['tzl']}와 일치(±0.05mm): {len(tzl_matches)}건")
    print(f"정답 px/mm이 {SEEN['pxPerMm']}과 일치(±0.005): {len(scale_matches)}건")
    print(f"정답 보정EZL이 {SEEN['ezl']}과 일치(±0.05mm): {len(ez_matches)}건")
    print(f"TZL·px/mm **동시** 일치: {len(both_matches)}건")
    print(f"EZL·TZL·px/mm **3중** 일치: {len(triple)}건")
    print()
    for row in both_matches[:5]:
        print(f"   익명#{row['cohortIndex']:3d}  정답 보정EZL {row['ezlCorrectedMm']:6.2f}"
              f"  전체곡선 {row['ezlFullCurveMm']:6.2f}  TZL {row['tzlMm']:6.2f}"
              f"  차이 {row['differenceMm']:+6.2f}  px/mm {row['pxPerMm']:6.2f}"
              f"  EZ점 {row['ezCount']}  폭 {row['widthCount']}")
    print()
    print("판정 근거: EZL·TZL·px/mm이 동시에 일치하는 정답 레코드가 있으면,")
    print("           화면 수치는 그 정답이 측정 상태로 들어간 결과다(자동분석 값이 아니다).")

    report = {
        "schemaVersion": "metric-panel-provenance-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("오른쪽 '측정 결과' 패널은 calculateEZL()이 갱신하며 전역 ezPoints/"
                 "toothWidths를 읽는다 — 하단 상세 수치와 동일 상태. showTruth()가 정답을 "
                 "그 전역에 써넣으므로 정답 확인 후에는 측정 결과 패널도 정답이 된다."),
        "screenValues": SEEN,
        "matchCounts": {"tzlMatches": len(tzl_matches), "scaleMatches": len(scale_matches),
                        "correctedEzlMatches": len(ez_matches),
                        "tzlAndScaleMatches": len(both_matches),
                        "tripleMatches": len(triple)},
        "matchedRecords": both_matches,
    }
    (HERE / "metric_panel_provenance.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
