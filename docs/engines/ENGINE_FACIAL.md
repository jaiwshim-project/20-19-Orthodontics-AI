# Lateral Profile Interpolation Engine (LPI-1)
**안모 시뮬레이션 엔진 · Facial Profile Simulation Engine**

| 항목 | 값 |
|---|---|
| 엔진 코드 | LPI-1 |
| 정식 명칭 | Lateral Profile Interpolation v1 (Ricketts E-line + Tweed soft tissue ratio) |
| 분류 | 실시간 SVG 좌표 보간 + Gemini 의미 해석 |
| 입력 변수 | 5종 슬라이더 (mm) |
| 출력 | 측면 안모 SVG 변형 + E-line 거리 + 코-턱 비율 |
| 코드 위치 | `facial-simulation.html` `transform()` `pathFromPoints()` `update()` |

---

## 1. 입력 파라미터 (Sliders)

| 키 | 단위 | 범위 | 의미 |
|---|---|---|---|
| `maxRetract` (sMaxRetract) | mm | -2 ~ +6 | 상악 후방 이동량 (양수 = 후방) |
| `mandShift` (sMandShift) | mm | -5 ~ +5 | 하악 전후방 이동 (양수 = 전방) |
| `lipUpper` (sLipUpper) | mm | -3 ~ +3 | 상순 위치 변화 (음수 = 후방) |
| `lipLower` (sLipLower) | mm | -3 ~ +3 | 하순 위치 변화 (음수 = 후방) |
| `chin` (sChin) | mm | -3 ~ +3 | 턱 (Pogonion) 위치 변화 (양수 = 전방) |

---

## 2. 표준 측면 랜드마크 좌표 (BASE)

SVG 좌표계 (viewBox 400×540), 1mm = 2.2px 스케일링:

| 랜드마크 | 정식명 | x | y | 임상 의미 |
|---|---|---|---|---|
| `N` | Nasion | 230 | 80 | 비전두 봉합 |
| `Sn` | Subnasale | 280 | 230 | 코기둥 기저점 |
| `A` | A-point | 268 | 260 | 상악 가장 후방 굴곡 |
| `Ls` | Labrale superius | 285 | 280 | 상순 정점 |
| `Li` | Labrale inferius | 275 | 320 | 하순 정점 |
| `B` | B-point | 250 | 360 | 하악 가장 후방 굴곡 |
| `Pog` | Pogonion | 255 | 400 | 턱끝 가장 전방점 |
| `Me` | Menton | 245 | 440 | 턱 가장 하방점 |
| `Forehead` | 이마 곡선 | 195 | 100 | 보조 |
| `NoseTip` | 코끝 (Pn) | 320 | 220 | E-line 시작점 |

---

## 3. 좌표 변형 공식 (transform)

```javascript
const k = 2.2;  // 1mm = 2.2px

after.A.x   -= maxRetract × k                                    // 상악 골격 (1:1)
after.Ls.x  -= maxRetract × k × 0.6 + (-lipUpper) × k            // 상순 = 상악×60% + 슬라이더
after.Li.x  += mandShift × k × 0.7 + (-lipLower) × k             // 하순 = 하악×70% + 슬라이더
after.B.x   += mandShift × k                                     // 하악 골격 (1:1)
after.Pog.x += mandShift × k + chin × k                          // 턱 = 하악 + 추가 chin
after.Me.x  += mandShift × k + chin × k × 0.7                    // 턱하단 = 하악 + chin×70%
```

### 핵심 비율 (Soft Tissue Response)
| 골격 변화 | 연조직 응답 비율 | 임상 근거 |
|---|---|---|
| 상악 1mm 후방 → 상순 0.6mm 후방 | 60% | Drobocky & Smith 1989 |
| 하악 1mm 전방 → 하순 0.7mm 전방 | 70% | Bishara et al. |
| 턱 chin 1mm → Me 0.7mm | 70% | Soft tissue chin |

---

## 4. Profile Path 생성 (pathFromPoints)

SVG `<path>` 베지어 곡선으로 11점 연결:

```
M Forehead.x Forehead.y
Q (N.x-10, N.y-10), (N.x, N.y)
Q (NoseTip.x+10, NoseTip.y-20), (NoseTip.x, NoseTip.y)
Q (Sn.x+6, Sn.y-5), (Sn.x, Sn.y)
L Ls.x Ls.y
Q (Li.x+8, (Ls.y+Li.y)/2), (Li.x, Li.y)
Q (B.x+4, (Li.y+B.y)/2), (B.x, B.y)
L Pog.x Pog.y
L Me.x Me.y
Q (Me.x-30, Me.y+12), (Me.x-60, Me.y-8)
```

`<path>`의 `fill: url(#skin)`, `stroke: #0EA5E9`로 채색.

---

## 5. E-line (Ricketts Esthetic Line) 측정

```
E-line = NoseTip → Pog 직선
distance(P, line) = |((b.y-a.y)·P.x - (b.x-a.x)·P.y + b.x·a.y - b.y·a.x)| / |b - a|

dU = distance(Ls, NoseTip, Pog) / 2.2  // 상순 ~ E-line (mm)
dL = distance(Li, NoseTip, Pog) / 2.2  // 하순 ~ E-line (mm)
```

| 미적 기준 (Ricketts 1968) | 상순 | 하순 |
|---|---|---|
| 이상적 | -4mm (E-line 후방) | -2mm |
| 정상 범위 | -2 ~ -6mm | 0 ~ -4mm |
| 돌출 (Convex) | 0 이상 | 0 이상 |

---

## 6. 코-턱 비율 (Nose-Chin Ratio)

```
noseLen = distance(N, NoseTip)
lowerFace = distance(Sn, Me)
ratio = noseLen / lowerFace
```

| 비율 | 평가 |
|---|---|
| 0.45 ~ 0.55 | 균형 (Ideal) |
| < 0.45 | 코가 짧거나 하안면부 길이 |
| > 0.55 | 코가 길거나 하안면부 짧음 |

---

## 7. Gemini 의미 해석 (`api/diagnose.js` type=facial)

### System Prompt
```
당신은 교정치과 안모 변화 시뮬레이션 AI입니다.
입력값을 기반으로 안모 변화 방향, 심미적 영향, 권장도(0-100), 5가지 근거를 JSON으로 반환.

스키마:
{
  "score": number,
  "recommendation": string,
  "facialChange": {
    "profileShift": string,
    "lipPosition": string,
    "chinPosition": string
  },
  "reasoning": [string],
  "risks": [string],
  "alternatives": [string]
}
```

호출 시 5개 슬라이더 값 + 환자 컨텍스트 전송.

---

## 8. 출력 스키마 예시

```json
{
  "score": 78,
  "recommendation": "안모 개선 효과 양호 — 상악 3mm 후방 + 상순 -2mm로 E-line 정상화",
  "facialChange": {
    "profileShift": "convex → straight",
    "lipPosition": "상순 -2.4mm 후방, 하순 -1mm 후방",
    "chinPosition": "Pog 0.8mm 전방 (genioplasty 미필요)"
  },
  "reasoning": [
    "상악 후방이동 3mm로 ANB 4° → 2.5° 골격 정상화 시뮬레이션",
    "E-line 기준 상순 -2.4mm 도달 (이상적 -4mm에 근접)",
    "하악 미세 전방 0.5mm로 안모 균형 유지",
    "코-턱 비율 0.52로 균형 범위 내",
    "입술 긴장도 완화로 폐구 자연스러움 개선"
  ],
  "risks": ["과도한 후방이동 시 비순각 둔화", "치근 흡수"],
  "alternatives": ["IPR + 미니스크류로 상악만 후방", "수술적 양악 전진"]
}
```

---

## 9. Snapshot 기능

```javascript
function snapshot() {
  const xml = new XMLSerializer().serializeToString(faceSvg);
  const svg64 = btoa(unescape(encodeURIComponent(xml)));
  // SVG → PNG 변환 (Canvas, 800×1080)
  // 다크 배경 + 프로파일 합성 → 다운로드
}
```

환자 상담용 Before/After PNG 이미지 생성.

---

## 10. 임상 근거

1. **Ricketts RM** — *Esthetics, environment, and the law of lip relation*. Am J Orthod, 1968.
2. **Drobocky OB, Smith RJ** — *Changes in facial profile during orthodontic treatment with extraction of four first premolars*. Am J Orthod Dentofacial Orthop, 1989.
3. **Bishara SE, et al.** — *Soft tissue profile changes from 5 to 45 years of age*. Am J Orthod Dentofacial Orthop, 1998.
4. **Burstone CJ** — *The integumental profile*. Am J Orthod, 1958.

---

## 11. 한계 + 주의사항

- **2D 측면 시뮬레이션 전용** — 정면 비대칭, 미소선, 치아 노출은 별도 평가 필요.
- 연조직 응답 비율(60-70%)은 평균값. 실제 환자별 ±20% 편차 가능.
- 본 엔진은 **상담용 시각화 도구** — 수술 계획 결정에는 CBCT 기반 3D 시뮬레이션 권장 (V2 로드맵).

---

## 12. 변경 이력
- v1.0 (2026-04-30): 5 슬라이더 + Soft tissue ratio + E-line + 코-턱 비율.
