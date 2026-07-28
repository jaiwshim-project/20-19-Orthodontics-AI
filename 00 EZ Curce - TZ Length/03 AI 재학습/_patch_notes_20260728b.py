#!/usr/bin/env python3
"""연구용 HTML에 2026-07-28 클래스2 폭 정답 2차(신규 116건) 학습 결과를 반영한다.

⑦에는 "폭 라벨을 더 넣는 것은 무이득"이라고 적혀 있었다. 이번 실측은 그 문장을
**부분적으로 뒤집는다** — 무이득이었던 것은 *기존 폴더에서 버려지던 부분 주석*이고,
*규약이 같은 완전 신규 완전 주석*은 좌표 MAE를 올렸다. 그래서 ⑦을 지우지 않고
⑧로 구분해 덧붙이고, ⑦의 단정 표현만 범위를 좁힌다(무엇이 무이득인지 명시).

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
    # 헤더: 표본 수 갱신 + ⑦의 "무이득" 단정을 범위 한정
    (
        """  // 학습 표본 폭 268 / EZ 113. **폭 라벨을 더 넣는 것은 무이득으로 실측됐다(⑦)** —
  // 남은 경로는 EZ 라벨과 주석 규약 정리다.""",
        """  // 학습 표본 폭 **384**(2026-07-28 클래스2 2차 116건 반영) / EZ 113.
  // **기존 폴더의 부분 주석**을 살리는 것은 무이득으로 실측됐지만(⑦),
  // **규약이 같은 완전 신규 완전 주석**은 좌표 MAE를 올렸다(⑧).""",
    ),
    # ⑦ (a) 문장의 주어를 "부분 주석"으로 못박아 ⑧과 충돌하지 않게 한다
    (
        """  // ⑦ **확보된 폭 정답은 소진됐다**(2026-07-27 실측, 4가지 전부 OOF). 새 라벨 없이
  //    학습량·탐색폭을 늘리는 시도는 모두 기각됐다.""",
        """  // ⑦ **그때 디스크에 있던 폭 정답은 소진됐다**(2026-07-27 실측, 4가지 전부 OOF).
  //    기존 폴더에서 학습량·탐색폭을 늘리는 시도는 모두 기각됐다.
  //    ⚠️ 이 결론의 범위는 **부분 주석 재활용과 격자 확장**이다. 새로 받은 완전 주석에는
  //    적용되지 않는다(⑧에서 실제로 이득이 나왔다).""",
    ),
    # ⑧ 신규
    (
        """  // 다음 과제: (a) EZ 라벨 100~200건 확충 — 유일하게 남은 실행 경로. 신규 촬영 불필요""",
        """  // ⑧ **완전 신규 코호트의 완전 주석 116건은 이득이다**(2026-07-28, 클래스2 2차).
  //    폭 표본 268 → 384. 승격 게이트 좌표 MAE 개선 35.6% → **39.8%**, 중첩 독립검증
  //    10/10 통과(파이프라인 재실행). ⑦과 모순이 아니다 — ⑦이 기각한 것은 규약이
  //    다른 **부분** 주석이고, 이쪽은 규약이 같은 **완전** 주석이다.
  //    (a) 넣기 전에 감사부터 했다(`_audit_new_labels.mjs`): 118건 중 117건 파싱,
  //        **116건이 치아 12개 완전 라벨**, 임베디드 이미지 SHA-256이 기존 라벨 폴더·번호
  //        root와 **중복 0건**, 상대폭 프로파일이 기존 완전 라벨 322건과 통계적으로 동일
  //        (평균 |z| 0.253). 남은 1건(11개)은 번호 위치가 정본을 가리키지 않아 자동 제외.
  //        ⑦(b)의 교훈을 절차로 만든 것 — **개수만 보고 넣지 않는다.**
  //    (b) 짝지어진 OOF A/B(평가 케이스를 기존 268건으로 **고정**하고 신규는 train에만
  //        넣어, 신규 데이터의 in-sample 이득이 섞이지 않게 했다):
  //        좌표 MAE +1.09%, 위치 +1.05%, 어금니 +0.65% (전부 시드 4/4 개선).
  //        그런데 **길이(폭)는 −5.17%로 4/4 시드 유의 악화**다. 순효과는 좌표 기준 개선.
  //    (c) 길이 악화는 **코호트 스케일 차**다. 필요 폭 배율(정답 TZL/초안 TZL)이 기존
  //        1.071 vs 신규 **1.169**. 폴드 내에서 배율을 재교정해도(1.015→1.021) −4.33%로
  //        남아, 전역 상수 한 개로는 해소되지 않는다([[label-cohort-scale-gap]]과 같은 벽).
  //        ⚠️ 즉 이 116건은 **위치·좌표를 개선하고 폭 스케일을 흐린다**. 폭 스케일을
  //        살리려면 코호트 지시자나 케이스별 배율 추정이 필요하다(미구현).
  //    (d) 라이브 in-sample 측정은 나빠져 보인다(TZL 3.00→3.86mm). 이는 일반화 저하가
  //        아니라 **커널 국소성 변화**다. 3단계 gamma가 4.0(좁음)→0.25(넓음)로 재선택돼
  //        학습 케이스를 덜 촘촘히 맞춘다. 같은 384 데이터에 **구 하이퍼파라미터**를 쓰면
  //        in-sample 좌표 0.9975→1.0264mm로 거의 그대로다(신 값은 1.2962mm).
  //        **학습 케이스로 재는 수치를 개선 근거로 쓰지 말 것** — OOF만 본다.
  //    (e) 이 과정에서 학습 입력이 오염돼 있던 것을 발견했다. `baseline_predictions.json`
  //        (규칙엔진 = 잔차의 기준선)이 `run_rule_baseline_fixed.js`(KRR 적용 엔진)의
  //        기본 출력과 **같은 파일명**이어서, root 119건이 모델 출력으로 덮여 있었다.
  //        그 상태로 학습하면 잔차가 0에 가까워져 게이트가 무관하게 깨진다(실제로 EZ
  //        게이트까지 흔들렸다). 규칙엔진으로 재생성해 335건 전부 비트 동일 복구하고,
  //        fixed 러너의 기본 출력명을 분리 + 규칙 baseline 파일명 쓰기 금지 가드를 넣었다.
  // 다음 과제: (a) EZ 라벨 100~200건 확충 — 유일하게 남은 실행 경로. 신규 촬영 불필요""",
    ),
    # 다음 과제 (c) 갱신: 코호트 스케일 차가 이번에 재확인됐다
    (
        """  //           (c) 주석 규약 정리(원장 확인 필요) — ⑦에서 구체화됐다. ①부분 주석의
  //               치아 번호 체계("6·7 결손" 가설 확인) ②TZL 재현성(재주석 시 총합
  //               2.64 mm 흔들림) ③코호트 스케일 차 p=0.0016. **폭 라벨을 더 받는
  //               것보다 이 정리가 먼저다** — 추가 폭 라벨은 무이득으로 실측됐다.""",
        """  //           (c) 주석 규약 정리(원장 확인 필요) — ⑦·⑧에서 구체화됐다. ①부분 주석의
  //               치아 번호 체계("6·7 결손" 가설 확인) ②TZL 재현성(재주석 시 총합
  //               2.64 mm 흔들림) ③**코호트 스케일 차** — 필요 폭 배율이 코호트마다
  //               1.071 vs 1.169로 갈린다(⑧c에서 재확인). 폭 라벨을 더 받을 때
  //               **누가 어떤 기준으로 폭을 찍었는지**를 함께 받아야 한다. 그러지 않으면
  //               좌표는 개선되고 폭 스케일은 흐려지는 교환이 계속된다.
  //           (d) 코호트 지시자 또는 케이스별 폭 배율 추정 — ⑧c의 벽을 넘는 유일한 방향.""",
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
