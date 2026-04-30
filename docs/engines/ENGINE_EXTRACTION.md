# Tweed-Steiner Composite Engine (TSC-1)
**발치 판단 AI 엔진 · Extraction Decision Engine**

| 항목 | 값 |
|---|---|
| 엔진 코드 | TSC-1 |
| 정식 명칭 | Tweed-Steiner Composite Engine v1 |
| 분류 | 임상 의사결정 보조 룰 + Gemini Pro JSON 진단 |
| 입력 변수 | 8종 (8 cephalometric + clinical metrics) |
| 출력 | extract / non_extract / borderline + score 0-100 |
| 코드 위치 | `extraction-ai.html` `computeRuleScore()` + `api/diagnose.js` `PROMPTS.extraction` |
| 갱신 | 입력 변경 시 즉시 재계산, Gemini는 [🧠 분석] 클릭 시 호출 |

---

## 1. 입력 파라미터

| 키 | 단위 | 범위 | 정상 | 임상 의미 |
|---|---|---|---|---|
| `anb` | ° | -2 ~ +8 | 2 ± 2 | A점-Nasion-B점 골격 관계 (Steiner) |
| `crowding` | mm | 0 ~ 20 | < 4 | 치열궁 부족량 (Proffit 기준) |
| `overjet` | mm | -10 ~ +20 | 2 ~ 4 | 상하악 전치 수평거리 |
| `overbite` | mm | -10 ~ +15 | 2 ~ 4 | 상하악 전치 수직 겹침 |
| `profile` | enum | straight / convex / concave | straight | 측면 안모 형태 |
| `lipStrain` | enum | none / mild / severe | none | 폐구 시 입술 긴장 정도 |
| `fma` | ° | 10 ~ 50 | 25 ± 5 | Frankfort-Mandibular Plane Angle (Tweed) |
| `impa` | ° | 70 ~ 110 | 90 ± 5 | Incisor-Mandibular Plane Angle (Tweed) |

추가 컨텍스트: 환자 `ageGroup` (`child` / `adult`)

---

## 2. 룰베이스 사전 점수 산출 (Rule-Based Pre-Score)

### 2-1. 가중치 공식

```
score = Σ(component_i)
```

| 구성 요소 | 공식 | 임상 근거 |
|---|---|---|
| **Crowding 가중** | `+ crowding × 6` | Proffit: 4mm↑ 발치 고려, 8mm↑ 강력 권장 |
| **ANB 편차** | `+ |ANB - 2| × 5` (편차 > 2.5°일 때만) | Steiner 분석 기준 |
| **Profile 가중** | `convex: +12 / concave: -8 / straight: 0` | 발치 후 안모 변화 방향 |
| **Lip Strain** | `severe: +10 / mild: +4 / none: 0` | 전치 돌출 간접 지표 |
| **Overjet 가중** | `overjet > 5mm 시 +8` | 외상 위험 + II급 시사 |
| **IMPA 편차** | `+ |IMPA - 90| × 0.6` (편차 > 5°일 때만) | Tweed 진단 삼각형 |

### 2-2. 어린이 가중치 (Pediatric Adjustment)

```
if patient.ageGroup === 'child':
    score = max(0, score - 25)
```

근거: 어린이는 성장 잠재력으로 비발치/2단계 치료가 우선 권장됨 (CVMS-driven approach).

### 2-3. 클램핑 + 최종 결정

```
score = clamp(score, 0, 100)

if score >= 60: recommendation = "extract"
elif score >= 40: recommendation = "borderline"
else: recommendation = "non_extract"
```

---

## 3. 발치 권장 치아 결정

```
if recommendation === "extract":
    if profile === "concave":
        teeth = ["14", "24"]   // 상악만 (안모 악화 방지)
    else:
        teeth = ["14", "24", "34", "44"]  // 표준 4개 소구치 발치
elif:
    teeth = []
```

FDI 표기: 14·24·34·44 = 상악 우/좌 제1소구치 + 하악 좌/우 제1소구치

---

## 4. Gemini 정밀 분석 (`api/diagnose.js` type=extraction)

### 4-1. System Prompt

```
당신은 교정치과 발치 판단 AI입니다.
입력된 환자 데이터를 기반으로 발치/비발치 권장도(0-100), 권장 발치 치아(FDI 표기),
5가지 근거, 위험요소, 비발치 대안을 JSON으로 반환하세요.

JSON 스키마:
{
  "score": number,
  "recommendation": "extract"|"non_extract"|"borderline",
  "teeth": [string],
  "reasoning": [string],
  "risks": [string],
  "alternatives": [string]
}

어린이(17세 이하)는 성장 잠재력을 고려해 발치 보류 가중치를 적용합니다.
KO_RULE: 모든 문자열 필드는 반드시 한국어로 작성. enum/숫자는 영문 유지.
```

### 4-2. Generation Config
- 모델: `gemini-2.5-flash`
- responseMimeType: `application/json`
- temperature: `0.2` (결정론적)

### 4-3. 후처리 (`diagnose.js`)

```javascript
parsed.score = clampScore(parsed.score, 0, 100)
if (!Array.isArray(parsed.reasoning)) parsed.reasoning = []
// risks, alternatives 동일
```

---

## 5. 출력 스키마

```json
{
  "score": 90,
  "recommendation": "extract",
  "teeth": ["14", "24", "34", "44"],
  "reasoning": [
    "심한 치열궁 길이 부족(severe arch length discrepancy)으로 인한 총생 해소 및 치아 배열 공간 확보.",
    "골격성 II급 부정교합 및 전치부 돌출 개선을 위한 전치부 후방 이동 공간 필요.",
    "과도한 수평피개(increased overjet) 감소 및 전치부 후방 이동을 통한 교합 개선.",
    "볼록한 안모 개선 및 심미성 향상을 위한 전치부 후방 이동.",
    "하악 전치부 순측 경사(IMPA 92) 개선 및 안정적인 교합 유도."
  ],
  "risks": [
    "치근 흡수(root resorption) 가능성",
    "블랙 트라이앵글(black triangle) 발생 가능성",
    "교정 치료 기간 증가",
    "발치 공간 폐쇄 지연",
    "치아 이동 시 통증 및 불편감"
  ],
  "alternatives": [
    "치간 삭제(IPR)를 통한 공간 확보",
    "악궁 확장 장치를 이용한 치열궁 확장",
    "미니스크류를 이용한 구치부 원심 이동",
    "전치부 경미한 전방 이동 허용",
    "환자 동의 하에 일부 잔존 총생 허용"
  ]
}
```

---

## 6. 임상 근거 (References)

1. **Tweed CH** — *The Frankfort-Mandibular Plane Angle in Orthodontic Diagnosis*. Angle Orthod, 1946.
2. **Steiner CC** — *Cephalometrics for you and me*. Am J Orthod, 1953.
3. **Proffit WR** — *Contemporary Orthodontics*, 6th ed. Elsevier, 2018. (Crowding 분류 기준)
4. **Andrews LF** — *The six keys to normal occlusion*. Am J Orthod, 1972.
5. **Down WB** — *Variations in facial relationships*. Am J Orthod, 1948.

---

## 7. 신뢰도 + 주의사항

- 룰베이스 점수는 **사전 스크리닝**용. 최종 판단은 Gemini Pro 분석 + 임상의 검증 필요.
- 어린이 가중치(-25)는 의도적 보수 정책. 실제 케이스에서는 CVMS 단계와 함께 종합 검토.
- 신뢰도 70% 미만 응답 시 추가 검사 (CBCT, Pano, Lateral Ceph) 권장.
- Class III (concave + ANB < 0): 발치 단독으로 해결 불가. 수술적 접근 검토.

---

## 8. 알고리즘 변경 이력
- v1.0 (2026-04-30): 초기 룰셋 + Gemini 2.5 Flash 통합. 어린이 -25 가중치, 0-100 클램프.
