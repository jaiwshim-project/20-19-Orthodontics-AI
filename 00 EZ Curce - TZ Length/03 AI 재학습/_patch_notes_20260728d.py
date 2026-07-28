#!/usr/bin/env python3
"""연구용 HTML 노트에 ⑩ 추가 — 라벨 회계·총효과·도달 상한·학습곡선 포화.

사용자 질문("550장 정답을 줬는데 왜 정확도가 안 오르나")에 대한 답을 노트에 남긴다.
지금까지 노트는 **증분**(직전 모델 대비)만 적어서 "정확도가 안 오른다"는 오해를 만들었다.
총효과(규칙엔진 대비 +41~47%)와 도달 상한(정답끼리 차이)을 함께 적어야 한다.

HTML은 CRLF. Python read_text/write_text가 번역하므로 치환문은 LF로 쓴다.
운영 HTML(보정 전)은 열지 않는다 — SHA만 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

REPLACEMENTS: list[tuple[str, str]] = [
    # 헤더에 총효과와 포화 사실을 먼저 박는다(증분만 읽고 오해하지 않게).
    (
        """  // ⚠️ ⑧(c)의 "주석자 코호트 스케일 차" 진단은 **틀렸다 — ⑨에서 정정**. 실체는
  // **클래스2 케이스 속성**이고, 지금 최우선 과제는 **클래스 정보를 모델 입력에 넣는 것**이다.""",
        """  // ⚠️ ⑧(c)의 "주석자 코호트 스케일 차" 진단은 **틀렸다 — ⑨에서 정정**. 실체는
  // **클래스2 케이스 속성**이다.
  // ⭐️ **총효과와 증분을 혼동하지 말 것**(⑩). 규칙엔진 대비 위치 **+41.1%** / 어금니
  //    **+45.8%** / TZL **+47.0%**가 정답 학습의 총효과다. ⑧의 −3.8%는 직전 모델 대비
  //    증분일 뿐이다. 그리고 폭 라벨 학습곡선은 **이미 포화**(기울기 −0.06~−0.10)라서
  //    폭 라벨을 2배로 늘려도 +4~6%뿐이다. 남은 여력은 **위치**(상한의 3.22배)에 있다.""",
    ),
    # ⑩ 신규 + 다음 과제 재편(EZ 라벨을 다시 1순위로)
    (
        """  // 다음 과제: (a) **클래스 정보를 폭 모델 입력에 추가 — 신규 1순위**(⑨). 라벨 0건으로
  //               클래스2 215건의 이득이 비클래스2로 새는 것을 막는다. 특징 벡터에 분류
  //               지시자를 넣거나 클래스별 모델로 분리한다. 사후 배율은 이미 기각(⑨d).
  //           (a2) EZ 라벨 100~200건 확충 — 여전히 유효하나 이제 2순위. 신규 촬영 불필요""",
        """  // ⑩ **라벨 회계·총효과·도달 상한·포화**(2026-07-28, `_truth_inventory.py`·
  //    `_truth_agreement.py`·`_accuracy_ceiling.py`). "550장 정답을 줬는데 왜 정확도가
  //    안 오르나"에 대한 답이다.
  //    (a) **정답은 유실 없이 다 쓰고 있다.** 5개 폴더 md 517개 → 같은 이미지 중복 65건
  //        통합 → 442 개별 이미지 → 12치 완전 주석 **384건 = 학습 표본 384건 전부**.
  //        나머지 58건은 9·10·11치 부분 주석(⑦에서 무이득으로 기각). 인덱스 도달률 100%.
  //    (b) **정확도는 크게 올랐다** (OOF, 시드 4종, 픽셀 등방 mm):
  //        위치 3.687→**2.172mm(+41.1%)**, 어금니 5.075→**2.752(+45.8%)**,
  //        최말단 5.400→**2.903(+46.2%)**, 길이 1.042→**0.778(+25.3%)**,
  //        TZL 11.083→**5.874(+47.0%)**. 클래스별로도 균형(위치 2.159 vs 2.189).
  //    (c) **도달 상한 = 정답끼리의 차이.** 같은 이미지에 정답이 둘 있는 **53건**에서
  //        모델 없이 정답끼리 비교: 끝점 **0.674mm**, 치아별 길이 **0.464mm**,
  //        TZL 총합 **−5.04mm(비 0.951)** — CI가 0을 포함하지 않으니 계통적이다.
  //        둘 다 원장 지도 정답이므로 이 차이는 오류가 아니라 **과제 고유 허용 오차**이고,
  //        AI가 이보다 정확해질 수는 없다(한쪽에 맞추면 다른 쪽 기준으로 틀려진다).
  //        ⚠️ **그 차이의 절반가량은 "최외곽 스팬=54mm" 가정에서 온다** — 공통 스케일
  //        5.04mm가 각자 스팬 환산 시 2.81mm로 줄어든다(스팬 비 0.979). 이미지에 실측
  //        기준이 없어 스케일을 가정으로 메우는 대가이며 **라벨로는 없어지지 않는다.**
  //    (d) **지금 상한에서 얼마나 떨어졌나**: 길이 **1.68배**, TZL **2.02배**,
  //        위치 **3.22배**. 남은 여력은 길이가 아니라 **위치**다(길이는 ⑦의 1.98배와 정합).
  //    (e) **폭 라벨 학습곡선은 포화다.** 384건을 40~100%로 잘라 재니 로그-로그 기울기가
  //        위치 −0.097 / 어금니 −0.094 / 길이 −0.078 / **TZL −0.059**. 교과서적 곡선은
  //        −0.5 안팎이므로 −0.1은 사실상 평평하다. 외삽: 폭 라벨 2배(768건) → 위치 +6.5%
  //        / TZL +4.0%, 4배 → +12.6% / +7.9%, 10배 → +20.0% / +12.7%. 허용 오차까지
  //        라벨만으로 가면 길이 **23만 건**, 위치 **5,300만 건**. 경로가 닫혀 있다.
  //        ⚠️ 이 외삽은 **현재 특징·현재 모델 고정** 하의 수치다. 특징을 바꾸면 곡선이
  //        갈아치워진다 — 그래서 답은 "라벨 더"가 아니라 "정보 종류를 바꿔라"다.
  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e). 여력이 남은 곳은 위치
  //               (상한의 3.22배)이고, 위치를 지배하는 아치 경로 정합은 기존 특징 회수율이
  //               0%인데 **EZ 정답만이** 설명했다(dyRel R²0.63 / logScale R²0.73).
  //               촬영 불필요(222장 대기). ⑨에서 2순위로 내렸던 판단을 되돌린다.
  //           (a2) **클래스 정보를 폭 모델 입력에 추가**(⑨). 라벨 0건으로 클래스2 215건의
  //               이득이 비클래스2로 새는 것을 막는다. 사후 배율은 이미 기각(⑨d).
  //           (a3) **같은 이미지 중복 주석 20~30장** — 클래스2의 허용 오차를 아직 모른다
  //               (겹친 53건이 전부 비클래스2 코호트다). 목표선 없이는 완료 판정을 못 한다.
  //           (a4) **촬영에 실측 스케일 기준 도입 검토(원장 확인)** — ⑩c의 절반을 라벨과
  //               무관하게 줄인다. 운영 방식 변경이므로 사람 판단이 필요하다.
  //           (a5) 폭 라벨 추가는 **후순위** — 2배 늘려 +4~6%(⑩e). 비용 대비 최악이다.""",
    ),
]


def main() -> None:
    before_bytes = RESEARCH.stat().st_size
    raw_before = RESEARCH.read_bytes()
    crlf_before = raw_before.count(b"\r\n")
    text = RESEARCH.read_text(encoding="utf-8")

    for index, (old, new) in enumerate(REPLACEMENTS, start=1):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"replacement {index}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")
    raw_after = RESEARCH.read_bytes()
    crlf_after = raw_after.count(b"\r\n")
    if crlf_after <= crlf_before:
        raise SystemExit("CRLF count did not grow - line endings may have been mangled")
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF - double conversion happened")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    print(f"research html: {before_bytes} -> {len(raw_after)} bytes")
    print(f"crlf lines: {crlf_before} -> {crlf_after}")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
