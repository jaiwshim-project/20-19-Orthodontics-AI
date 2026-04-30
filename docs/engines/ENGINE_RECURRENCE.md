# Multi-Factor Relapse Prediction Engine (MFR-1)
**재발 예측 AI 엔진 · Recurrence Prediction Engine**

| 항목 | 값 |
|---|---|
| 엔진 코드 | MFR-1 |
| 정식 명칭 | Multi-Factor Relapse Risk v1 |
| 분류 | 가중 합산 + 시간 분포 + Gemini structured output |
| 입력 변수 | 8종 (post-treatment metrics + retention protocol) |
| 출력 | 1·3·5·10년 재발 확률 (%) + 위험 요인 + 권장 보정 프로토콜 |
| 코드 위치 | `recurrence-prediction.html` `computeRule()` + `api/diagnose.js` `PROMPTS.recurrence` |

---

## 1. 입력 파라미터

| 키 | 단위 | 범위 | 의미 |
|---|---|---|---|
| `impa` | ° | 70 ~ 110 | 치료 종료 시 IMPA |
| `incisorShift` | mm | -5 ~ +5 | 하악 절치 위치 변화 (양수 = 전방) |
| `retainer` | enum | hawley / essix / bonded / dual | 보정 장치 종류 |
| `retentionMonths` | 개월 | 0 ~ 60+ | 보정 장치 착용 기간 |
| `compliance` | enum | high / medium / low | 환자 협조도 |
| `extracted` | bool | true / false | 발치 여부 |
| `residual` | mm | 0 ~ 5 | 치료 종료 시 잔여 Crowding |
| `thirdMolar` | enum | absent / present | 제3대구치 (사랑니) 매복 여부 |

---

## 2. Baseline + 가중치 합산 (10년 누적 기준)

```
base = 25  // 일반 인구 baseline 25% (Little 1981 follow-up)

// IMPA 편차 가중
if abs(impa - 90) > 5:
    base += abs(impa - 90) × 1.2

// 절치 변화 가중
if abs(incisorShift) > 1.5:
    base += abs(incisorShift) × 3

// 보정장치
retainerWeight = { hawley: +5, essix: 0, bonded: -10, dual: -15 }
base += retainerWeight[retainer]

// 보정 기간
if retentionMonths < 12: base += 12
elif retentionMonths >= 36: base -= 8

// 협조도
complianceWeight = { high: -10, medium: 0, low: +18 }
base += complianceWeight[compliance]

// 잔여 Crowding
if residual > 1: base += residual × 4

// 제3대구치
if thirdMolar === 'present': base += 8

// 발치 여부
if extracted: base -= 4

// 클램프
base = clamp(base, 2, 95)
```

### 가중치 요약 표

| 변수 | 위험 증가 (+) | 위험 감소 (-) |
|---|---|---|
| IMPA 편차 5° 이상 | × 1.2 / 도 | — |
| 절치 변화 1.5mm 이상 | × 3 / mm | — |
| Hawley 보정 | +5 | — |
| Essix 보정 | 0 | 0 |
| Bonded 보정 | — | -10 |
| Dual 보정 | — | -15 |
| 보정 < 12개월 | +12 | — |
| 보정 ≥ 36개월 | — | -8 |
| 협조도 하 | +18 | — |
| 협조도 중 | 0 | 0 |
| 협조도 상 | — | -10 |
| 잔여 Crowding 1mm↑ | × 4 / mm | — |
| 제3대구치 매복 | +8 | — |
| 발치 케이스 | — | -4 |

---

## 3. 시간 경과별 분포 공식

```
probabilities = {
  y1:  base × 0.18,    // 1년 시점
  y3:  base × 0.42,    // 3년
  y5:  base × 0.68,    // 5년
  y10: base            // 10년 (누적 최대)
}
```

근거: Little 1999 long-term study — 재발은 치료 종료 직후 가속, 5-10년에 안정.

| 시점 | 비율 | 누적률 (base=40 예시) |
|---|---|---|
| 1년 | 18% × base | 7.2% |
| 3년 | 42% × base | 16.8% |
| 5년 | 68% × base | 27.2% |
| 10년 | 100% × base | 40% |

---

## 4. 위험도별 권장 프로토콜

```javascript
if probabilities.y10 > 50:
    protocol = "🚨 고위험 — Bonded 3-3 + 야간 Essix + 6개월 정기 검진"
elif probabilities.y10 > 30:
    protocol = "⚠️ 중위험 — Essix 야간 착용 + 1년 검진"
else:
    protocol = "✅ 저위험 — Essix 24개월 야간 착용 후 점진적 중단"
```

---

## 5. 권장 대책 자동 생성

| 조건 | 권장 |
|---|---|
| `compliance === 'low'` | Bonded 고정 보정으로 전환 검토 |
| `retentionMonths < 24` | 보정 기간 24개월 이상으로 연장 |
| `thirdMolar === 'present'` | 제3대구치 발치 권장 |
| `abs(incisorShift) > 2` | 하악 3-3 영구 retainer 권장 |
| `probabilities.y10 > 50` | 치료 종료 1년 시점 정기 재평가 + 즉각 개입 |
| (없으면) | 현재 프로토콜 유지 |

---

## 6. Gemini 정밀 분석 (`api/diagnose.js` type=recurrence)

### System Prompt
```
당신은 교정치과 재발 예측 AI입니다.
입력값을 기반으로 1/3/5/10년 재발 확률, 위험 요인, 권장 보정 프로토콜을 JSON으로 반환.

스키마:
{
  "score": number,
  "recommendation": string,
  "probabilities": {"y1": number, "y3": number, "y5": number, "y10": number},
  "reasoning": [string],
  "risks": [string],
  "alternatives": [string]
}
KO_RULE: 한국어 강제.
```

### Probabilities 정규화 (`diagnose.js`)
Gemini가 0-1 또는 0-100 어느 스케일로 반환해도 자동 변환:

```javascript
function normalizeProbabilities(p) {
  const maxVal = max(p.y1, p.y3, p.y5, p.y10);
  const factor = maxVal <= 1 ? 100 : 1;
  return { y1: p.y1*factor, y3: p.y3*factor, y5: p.y5*factor, y10: p.y10*factor };
}
```

---

## 7. 출력 스키마 예시

```json
{
  "score": 42,
  "recommendation": "중위험 — Essix 야간 착용 + 1년 검진",
  "probabilities": {
    "y1": 7.6,
    "y3": 17.6,
    "y5": 28.6,
    "y10": 42.0
  },
  "reasoning": [
    "IMPA 92도로 정상 범위(90±5) 내 위치, 안정성 양호.",
    "Essix 보정 + 24개월 착용으로 표준 프로토콜 충족.",
    "환자 협조도 중 — 야간 착용 일관성 확보 필요.",
    "비발치 케이스로 발치보다 약 4% 위험 증가.",
    "잔여 Crowding 0.5mm로 안정 범위 내."
  ],
  "risks": [
    "협조도 저하 시 5년 시점 재발 가속",
    "제3대구치 매복 시 +8% 추가 위험"
  ],
  "alternatives": [
    "Bonded 3-3 retainer 추가로 협조도 의존성 최소화",
    "보정 36개월 이상 연장으로 안정성 강화"
  ]
}
```

---

## 8. 임상 근거

1. **Little RM** — *The irregularity index: a quantitative score of mandibular anterior alignment*. Am J Orthod, 1975.
2. **Little RM, Riedel RA, Årtun J** — *An evaluation of changes in mandibular anterior alignment from 10 to 20 years postretention*. Am J Orthod Dentofacial Orthop, 1988.
3. **Renkema AM, et al.** — *Long-term effectiveness of canine-to-canine bonded flexible spiral wire lingual retainers*. Eur J Orthod, 2008.
4. **Sadowsky C, Sakols EI** — *Long-term assessment of orthodontic relapse*. Am J Orthod, 1982.
5. **Naraghi S, et al.** — *Influence of third molars on the position of the lower incisors*. Eur J Orthod, 2010.

---

## 9. 한계 + 주의사항

- **단일 환자 리스크 평가 모델** — 인구 통계 기반이므로 개별 변수 비선형 효과 미반영.
- 보정장치 가중치는 평균값 — 환자별 구강 구조·치아 형태 영향 미고려.
- 5년 이상 데이터는 외삽(extrapolation) — 실제 임상 데이터셋 1만 케이스 필요.
- 본 엔진은 **상담용 위험도 가시화** — 정밀 예측은 CBCT 기반 ML 모델 (V2 로드맵).

---

## 10. 변경 이력
- v1.0 (2026-04-30): Baseline 25% + 8 가중 변수 + 시간 분포 곡선.
