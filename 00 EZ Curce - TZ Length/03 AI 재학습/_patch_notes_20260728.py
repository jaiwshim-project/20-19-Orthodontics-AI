#!/usr/bin/env python3
"""연구용 HTML의 연구 노트에 2026-07-27 '기존 정답 소진' 실측을 반영한다.

HTML은 CRLF로 저장돼 있다. Python `read_text`가 LF로 번역해 읽고 `write_text`가
os.linesep으로 되돌려 쓰므로, 치환 문자열은 LF로 쓰면 된다. 대신 **치환 전후로
바이트 크기와 CRLF 유지**를 확인해야 한다(과거에 이 지점에서 사고가 있었다).

운영 HTML은 건드리지 않는다 — 이 스크립트는 연구용 파일만 연다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

REPLACEMENTS: list[tuple[str, str]] = [
    # ⑦ 신규: 기존 정답으로 더 학습해도 무이득이라는 실측 + 그 이유
    (
        """  //    단 EZ **정답** 곡선 기하는 세로 이동(R² 0.63)과 배율(R² 0.73)을 설명한다.
  // 다음 과제:""",
        """  //    단 EZ **정답** 곡선 기하는 세로 이동(R² 0.63)과 배율(R² 0.73)을 설명한다.
  // ⑦ **확보된 폭 정답은 소진됐다**(2026-07-27 실측, 4가지 전부 OOF). 새 라벨 없이
  //    학습량·탐색폭을 늘리는 시도는 모두 기각됐다.
  //    (a) 버려지던 부분 주석 31건(치아 단위 319개)을 치아별로 살리면 위치 −9.96%,
  //        어금니 −3.51%로 **악화**. 커널 기하(표준화·gamma·게이트)를 완전 주석
  //        집합에서 고정해도 −9.65%라 적합 교란이 원인이 아니다.
  //    (b) 원인은 **치아 번호 규약 불일치**다. 10개만 주석된 케이스의 번호 1~10은
  //        정본 1~10이 아니다. 상대폭 프로파일이 양 끝 모두 크다(0.253/0.226 —
  //        완전 주석은 0.261/0.169). 단조 10-of-12 매핑 66가지를 z 적합도로 세우면
  //        "11·12 결손"(코드가 암묵 가정하던 해석)은 **66위**(z=1.401, 최악)이고
  //        최적은 "**6·7 결손**"(z=0.250) — 발치 후 남은 치아에 1~10을 재부여한 것으로
  //        보인다. 번호를 그대로 믿으면 **다른 치아의 정답을 학습**한다.
  //        ⚠️ 통계적 추정이다. 쓰기 전에 원본 이미지에서 사람이 확인해야 한다.
  //    (c) 하이퍼파라미터 격자 확장(gammaFactor 0.0625~16, lambda 1e-5~100)도 기각.
  //        선택값이 격자 경계(4.0/1.0)에 붙어 있어 여력처럼 보였지만, 넓히면 시드
  //        4종 전부 어금니 −2.8%·최말단 −3.5%로 악화된다. **경계 = 여력의 증거가 아니다.**
  //    (d) 라벨 재현오차(같은 이미지 재주석 53건/55쌍): 위치는 합의값 대비 0.239 mm로
  //        모델 오차 2.30 mm의 1/9.6 — 위치에는 원리적 여력이 남아 있다. 그러나
  //        **TZL 총합은 합의값 대비 2.64 mm**(주석 쌍 사이로는 4.82 mm)이고 모델 오차는
  //        5.22 mm, 즉 **1.98배뿐**이다. TZL 정확도는 학습량으로 못 올린다 — 정답이
  //        흔들리는 폭만큼은 어떤 모델도 맞출 수 없다. **주석 규약 일관성이 먼저다.**
  //        ⚠️ 재현오차는 공통 편향을 잡지 못하고, 재주석 케이스는 어려운 쪽으로
  //        치우쳤을 수 있어 하한을 과대추정할 수 있다.
  // 다음 과제:""",
    ),
    # 다음 과제 (c) 갱신 — 라벨 품질 정리의 내용이 ⑦로 구체화됐다
    (
        """  //           (c) 라벨 품질 정리(폭 라벨 다중버전 65건, 코호트 스케일 차 p=0.0016)""",
        """  //           (c) 주석 규약 정리(원장 확인 필요) — ⑦에서 구체화됐다. ①부분 주석의
  //               치아 번호 체계("6·7 결손" 가설 확인) ②TZL 재현성(재주석 시 총합
  //               2.64 mm 흔들림) ③코호트 스케일 차 p=0.0016. **폭 라벨을 더 받는
  //               것보다 이 정리가 먼저다** — 추가 폭 라벨은 무이득으로 실측됐다.""",
    ),
    # 헤더 한 줄 추가: 폭 라벨 추가가 무이득임을 최상단에서 알 수 있게
    (
        """  // KRR 사용 여부. **3단계(반복) 잔차보정** + 중첩검증 통과(시드 4종 모두).
  // 단계별 캡 5%, 누적 캡 15%(2026-07-27 2단계·누적10% → 3단계·누적15%).""",
        """  // KRR 사용 여부. **3단계(반복) 잔차보정** + 중첩검증 통과(시드 4종 모두).
  // 단계별 캡 5%, 누적 캡 15%(2026-07-27 2단계·누적10% → 3단계·누적15%).
  // 학습 표본 폭 268 / EZ 113. **폭 라벨을 더 넣는 것은 무이득으로 실측됐다(⑦)** —
  // 남은 경로는 EZ 라벨과 주석 규약 정리다.""",
    ),
]


def main() -> None:
    before_bytes = RESEARCH.stat().st_size
    text = RESEARCH.read_text(encoding="utf-8")
    raw_before = RESEARCH.read_bytes()
    crlf_before = raw_before.count(b"\r\n")

    for index, (old, new) in enumerate(REPLACEMENTS, start=1):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"replacement {index}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")
    raw_after = RESEARCH.read_bytes()
    crlf_after = raw_after.count(b"\r\n")
    if crlf_after <= crlf_before:
        raise SystemExit("CRLF count did not grow — line endings may have been mangled")
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF — double conversion happened")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed — must never happen")

    print(f"research html: {before_bytes} -> {raw_after.__len__()} bytes")
    print(f"crlf lines: {crlf_before} -> {crlf_after}")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
