# CVMS-Mid-Parental Growth Engine (CMG-1)
**성장 예측 AI 엔진 · Growth Prediction Engine**

| 항목 | 값 |
|---|---|
| 엔진 코드 | CMG-1 |
| 정식 명칭 | CVMS × Mid-Parental Height Composite v1 |
| 대상 | 어린이/청소년 (만 17세 이하 권장) |
| 입력 변수 | 7종 (anthropometric + skeletal maturation) |
| 출력 | 잔여 성장량 (cm) + 골성숙 단계 + 권장 치료 시기 |
| 코드 위치 | `growth-prediction.html` `computeRule()` + `api/diagnose.js` `PROMPTS.growth` |

---

## 1. 입력 파라미터

| 키 | 단위 | 범위 | 임상 의미 |
|---|---|---|---|
| `height` | cm | 130 ~ 200 | 환자 현재 신장 |
| `weight` | kg | 20 ~ 100 | 환자 현재 체중 |
| `father` | cm | 150 ~ 200 | 아버지 신장 |
| `mother` | cm | 140 ~ 190 | 어머니 신장 |
| `boneAge` | 세 | 5 ~ 20 | 골연령 (손목 X-ray, MP3·sesamoid 평가) |
| `chronAge` | 세 | 5 ~ 20 | 역연령 (만 나이) |
| `cvms` | 1-6 | 1 ~ 6 | 경추 골성숙 단계 (Baccetti) |

추가 컨텍스트: 환자 `gender` (mid-parental 계산용)

---

## 2. Mid-Parental Target Height (Tanner)

```javascript
function midParental(father, mother, gender) {
  if (gender === 'female') return (father + mother - 13) / 2;  // 여아: -13cm
  return (father + mother + 13) / 2;                            // 남아: +13cm
}
```

근거: 부모의 평균 신장에 성별 보정 13cm를 가감해 자녀의 유전적 성장 잠재력 추정 (Tanner-Whitehouse).

---

## 3. CVMS 기반 잔여 성장 인자 (Growth Factor)

```
growthFactors = {
  CS1: 0.95,   // 사춘기 가속 전 — 95% 미발현
  CS2: 0.85,   // 가속 시작 — 85% 잔존
  CS3: 0.55,   // ★ Peak velocity — 55% 잔존 (골든타임)
  CS4: 0.30,   // Peak 직후 — 30% 잔존
  CS5: 0.10,   // 감속 — 10% 잔존
  CS6: 0.02    // 성장 완료 — 2% 미만
}
factor = growthFactors[cvms] || 0.5
```

근거: Baccetti et al. 2005 — 경추 C2-C4 형태 변화로 골 성숙 단계 분류.

---

## 4. 잔여 성장량 추정 공식

```
target = midParental(father, mother, gender)
remainingFromTarget = max(0, (target - height) × factor + (1 - factor) × 0)
ageAdjust = -(boneAge - chronAge) × 0.8     // 골연령이 빠르면 잔여 ↓
remaining = max(0, remainingFromTarget + ageAdjust)
finalHeight = height + remaining
```

| 구성 요소 | 의미 | 예시 (CS3, target=170, height=145, boneAge=11.5, chronAge=11) |
|---|---|---|
| target - height | 부모 평균까지 갈 수 있는 거리 | 25cm |
| × factor (0.55) | CVMS 단계별 잔여 가능 비율 | 13.75cm |
| ageAdjust | 골 성숙 가속 보정 | -0.4cm |
| remaining | 최종 잔여 추정 | 13.4cm |
| finalHeight | 예상 최종 신장 | 158.4cm |

---

## 5. 권장 치료 시기 매핑

| CVMS | 메시지 | 임상 액션 |
|---|---|---|
| CS1 | 아직 이른 단계 — 6-12개월 후 재평가 | 모니터링 |
| CS2 | 치료 시작 적기 — 기능 장치 효과 큼 | 기능 장치(Twin Block, Headgear) 도입 검토 |
| CS3 | ★ Peak velocity — 골격성 치료 골든타임 (즉시 시작 권장) | Class III chin cup, Face mask 효과 최대 |
| CS4 | Peak 직후 — 신속한 치료 진행 | 골격성 치료 가속화 |
| CS5 | 감속 단계 — 캐모플라쥬 또는 수술 검토 | 잔여 성장 부족 |
| CS6 | 성장 완료 — 성인 프로토콜 적용 | TSC-1 발치 판단 엔진으로 분기 |

---

## 6. 성장 곡선 시각화 (Sigmoid-ish Curve)

```javascript
// growthCurve(targetAge=8 to 18)
for (a = 8; a <= 18; a++) {
  t = (a - chronAge) / 7
  grown = clamp(0.5 + 0.5 × tanh(t), 0, 1)
  height_at_a = currentHeight + grown × (finalHeight - currentHeight)
}
// 하악골 길이는 t-0.3 시점 (피크가 신장보다 늦음)
```

Peak velocity 시점 = `chronAge`(CS3 기준) ~ `chronAge - 2.5`(CS6 기준).

---

## 7. Gemini 정밀 분석 (`api/diagnose.js` type=growth)

### System Prompt
```
당신은 교정치과 성장 예측 AI입니다.
입력된 환자(어린이) 데이터를 기반으로 잔여 성장량, 골성숙 단계, 권장 치료 시기,
5가지 근거를 JSON으로 반환하세요.

스키마:
{
  "score": number,
  "remainingGrowthCm": number,
  "skeletalStage": string,
  "recommendation": string,
  "reasoning": [string],
  "risks": [string],
  "alternatives": [string]
}
KO_RULE: 한국어 강제.
```

### Generation Config
- 모델: `gemini-2.5-flash`
- temperature: 0.2

---

## 8. 출력 스키마 예시

```json
{
  "score": 75,
  "remainingGrowthCm": 13.4,
  "skeletalStage": "CS3 (Peak velocity)",
  "recommendation": "골격성 치료 즉시 시작 권장 — Class II 시 Twin Block, Class III 시 Face mask 적용",
  "reasoning": [
    "CVMS 3단계로 peak growth velocity에 도달, 골격 변화 효과가 가장 큰 시기.",
    "잔여 성장 13.4cm로 추정되어 기능 장치 적용 가능 윈도 확보.",
    "골연령(11.5세)과 역연령(11세) 차이가 6개월로 정상 범위 내.",
    "부모 평균 키 170cm 기준 mid-parental height 도달 가능성 높음.",
    "BMI 정상 범위로 영양 상태 양호, 호르몬 균형 적정."
  ],
  "risks": [
    "환자 협조도 부족 시 기능 장치 효과 감소",
    "성장 폭발기 종료 시 Class III 외과 수술 불가피"
  ],
  "alternatives": [
    "CS4 진입 시 신속 골격 치료로 전환",
    "성장 완료 후 캐모플라쥬 치료 또는 양악 수술"
  ]
}
```

---

## 9. 임상 근거

1. **Baccetti T, Franchi L, McNamara JA Jr.** — *An Improved Version of the Cervical Vertebral Maturation (CVM) Method*. Angle Orthod, 2005.
2. **Tanner JM, Whitehouse RH** — *Mid-parental height for predicting adult height*. Arch Dis Child, 1976.
3. **Greulich WW, Pyle SI** — *Radiographic Atlas of Skeletal Development of the Hand and Wrist*, 2nd ed. Stanford, 1959.
4. **Hägg U, Taranger J** — *Maturation indicators and the pubertal growth spurt*. Am J Orthod, 1982.

---

## 10. 한계 + 주의사항

- **신장/체중은 사진으로 측정 불가** — 환자 직접 입력 필수.
- **CVMS는 Lateral Ceph로만** 정확 측정 가능. 손목 X-ray 골연령은 보조 지표.
- 사춘기 시기 개인차 ±1.5년 → 6개월 단위 재측정 권장.
- 본 엔진 = **임상 보조 도구**. 엔도크린 평가 필요 시 소아과/내분비내과 의뢰.

---

## 11. 변경 이력
- v1.0 (2026-04-30): mid-parental + CVMS factor + age delta 보정 통합.
