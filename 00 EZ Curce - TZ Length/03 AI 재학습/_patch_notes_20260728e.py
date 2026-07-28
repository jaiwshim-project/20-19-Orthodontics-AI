#!/usr/bin/env python3
"""연구용 HTML에 노트 ⑪(좌우 어금니 격차 재측정) 추가 + 헤더 경고 한 줄.

핵심: 이전 "좌우 편향 없음" 판정은 구세대 모델 것이고 현재 모델에서는 뒤집혔다.
그리고 **관찰(왼쪽이 정확)과 측정(오른쪽이 정확)의 방향이 반대**라는 사실을 코드
가까이에 남겨야 한다 — 나중에 좌우 대책을 짜려는 사람이 방향을 거꾸로 잡지 않도록.

HTML은 CRLF. read_text/write_text가 개행을 번역하므로 교체 문자열은 LF로 쓰고,
쓰기 후 CRLF 수 증가와 \r\r\n 부재를 확인한다. 운영 HTML은 SHA만 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

HEADER_OLD = """\
  //    폭 라벨을 2배로 늘려도 +4~6%뿐이다. 남은 여력은 **위치**(상한의 3.22배)에 있다.
  // 자동배포가 아니라 사람 검토 대상이므로 여기서도 "연구·초안" 모드로만 적용한다.
"""

HEADER_NEW = """\
  //    폭 라벨을 2배로 늘려도 +4~6%뿐이다. 남은 여력은 **위치**(상한의 3.22배)에 있다.
  // ⚠️ **좌우 어금니 격차는 이제 실재한다**(⑪ — 구판정 "편향 없음"은 폐기). 다만
  //    측정상 정확한 쪽은 **오른쪽**(위치 −8.01% / 길이 −11.26%, 시드 4/4 유의)이고
  //    이는 육안 관찰과 방향이 반대다. 좌우 전용 대책을 짜기 전에 ⑪을 읽을 것.
  // 자동배포가 아니라 사람 검토 대상이므로 여기서도 "연구·초안" 모드로만 적용한다.
"""

NOTE_ANCHOR = "  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e)."

NOTE = """\
  // ⑪ **좌우 어금니 격차 — 실재하지만 방향이 반대다**(2026-07-28, `_molar_lr3.py`·
  //    `_molar_lr4.py`). 관찰은 "왼쪽 어금니가 오른쪽보다 정확하다"였다.
  //    ⚠️ **이전 판정(격차 1.34%·CI 0 포함 = 편향 없음)은 폐기한다.** 그것은 2단계·
  //    268건·bias 1.051 시절 측정이다. 모델이 두 번 바뀐 뒤 재사용하면 안 된다.
  //    (a) **격차는 실재한다. 그런데 오른쪽이 더 정확하다.** KRR OOF, 시드 4종,
  //        (오른쪽 − 왼쪽): 어금니 위치 **−8.01%**(4/4 유의), 길이 **−11.26%**(4/4),
  //        최말단 위치 −7.46%(3/4). 음수 = 오른쪽(치아11·12)이 정확. 좌우 규약은
  //        384/384 일관(치아1·2 = 영상 왼쪽)이므로 규약 뒤집힘이 아니다.
  //        치아별로 보면 끝으로 갈수록 벌어진다: 최외곽 3.020 vs 2.817(−0.203mm),
  //        2번째 2.709 vs 2.492(−0.218), 중앙(치아6·7)은 +0.048 = 사실상 0.
  //    (b) **관찰과 어긋난 이유 두 가지.** ① **케이스별로는 거의 반반**이다 — 오른쪽이
  //        더 나쁜 케이스 비율 위치 45.8% / 길이 42.7%. 평균 편향을 개별 케이스에
  //        적용하면 안 된다. ② **정답끼리는 왼쪽이 더 일치한다**(n=53, 모델 미개입):
  //        어금니 위치 차 L 0.667 vs R **0.836mm = +25.4%, 유의**. 오른쪽은 "정답이
  //        덜 확정된 쪽"이므로 화면에서 정답선과 AI선을 눈으로 겹쳐 보면 더 안 맞아
  //        보인다. **"AI가 정답을 맞히는 정확도"와 "정답이 확정적인 정도"는 다른 것**이고
  //        육안 관찰은 후자에 끌린다.
  //    (c) **원인은 규칙엔진이 아니라 이 보정 층이다.** 초안의 좌우 격차는 위치 −2.83%
  //        (CI [−10.22, 5.15]) · 길이 −1.93% — 둘 다 CI가 0을 포함해 무의미하다.
  //        **보정 후에 비대칭이 생긴다.**
  //    (d) 가설 4종 실측. **H1 정답 비대칭 → 기각**(어금니 정답 폭 좌우 차 +0.008mm,
  //        CI [−0.033, 0.049]; 클래스2·비클래스2 각각도 CI 0 포함). **H3 촬영 회전 →
  //        기각**(최말단 연결선 기울기 클래스2 −0.11° vs 비클래스2 −0.12°). 단 분산은
  //        다르다(std 2.86° vs 2.25°).
  //    (e) **H2 = 진짜 구조.** 초안의 **아치 방향(along) 오차가 좌우 반대 부호**다:
  //        전체 L **+3.726** / R **−3.861mm**, 클래스2 L +5.181 / R −5.129,
  //        비클래스2 L +1.876 / R −2.247. **초안 아치가 실제보다 짧아서 양쪽 어금니를
  //        중앙 쪽으로 끌어당긴다.** 이것이 어금니 오차의 지배 성분이고(along 3.7~5.2 vs
  //        inward 1.0~1.5mm) 클래스2에서 1.4배 크다. ②의 "절반은 아치 경로 오정합"과
  //        같은 현상을 방향까지 붙여 본 것이다.
  //    (f) **H4 = 직접 원인.** 필요 이동량 대비 실제 이동 비율(1.0 = 딱 맞음):
  //        전체 L 1.101 / R 1.274, 클래스2 L 1.081 / R 1.056, 비클래스2 L 1.128 /
  //        R **1.551**. 양쪽 다 과보정인데 오른쪽을 더 세게 민다. 그 결과 남은 along
  //        잔차가 클래스2에서 L **+0.855** / R −0.723mm — 초안 편향은 좌우 거의 같았는데
  //        (+5.181 vs −5.129) 보정 배분이 기울어 **왼쪽에 덜 고쳐진 몫이 남는다.**
  //        격차는 "왼쪽이 어려워서"가 아니라 **"보정이 좌우로 비대칭 배분돼서"** 생긴다.
  //    (g) **그래서 좌우 전용 대책은 우선순위가 아니다.** 뿌리는 좌우가 아니라 아치
  //        경로 정합(along)이고, 그 정보는 EZ 정답에만 있다(⑥·⑩) → ⑩의 1순위와 동일한
  //        결론이다. 저비용 후보로 **좌우 미러 증강**(케이스 좌우 반전, 라벨 0건)이 있으나
  //        along 자체를 줄이지 못하므로 격차만 없애고 총오차는 그대로일 가능성이 높다.
  //        **아직 측정하지 않았다** — 하기 전에 A/B로 잴 것.
  //    ⚠️ 정답 좌우 불일치 근거 53건은 전부 비클래스2 코호트다. 클래스2에서 어느 쪽
  //        주석이 더 흔들리는지는 모른다(⑩의 (a3)와 같은 공백).
"""


def main() -> None:
    text = RESEARCH.read_text(encoding="utf-8")
    before_bytes = len(RESEARCH.read_bytes())
    raw_before = RESEARCH.read_bytes()

    if "⑪" in text:
        raise SystemExit("note 11 already present - refusing to duplicate")

    replacements = [
        (HEADER_OLD, HEADER_NEW),
        (NOTE_ANCHOR, NOTE + NOTE_ANCHOR),
    ]
    for index, (old, new) in enumerate(replacements, start=1):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"replacement {index}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")

    raw_after = RESEARCH.read_bytes()
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF - double conversion happened")
    crlf = bytes([13, 10])
    if raw_after.count(crlf) <= raw_before.count(crlf):
        raise SystemExit("CRLF line count did not grow - line endings were mangled")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    print(f"research html: {before_bytes} -> {len(raw_after)} bytes")
    print(f"crlf lines: {raw_before.count(crlf)} -> {raw_after.count(crlf)}")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
