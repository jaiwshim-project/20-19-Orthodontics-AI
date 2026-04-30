# 4대 AI 엔진 알고리즘 명세

**20-19 Orthodontics AI** 플랫폼이 사용하는 4개 임상 의사결정 보조 엔진의 알고리즘과 임상 근거를 정리한 문서.

---

## 엔진 일람

| 코드 | 정식명 | 페이지 | 문서 |
|---|---|---|---|
| **TSC-1** | Tweed-Steiner Composite Engine | `extraction-ai.html` | [ENGINE_EXTRACTION.md](./ENGINE_EXTRACTION.md) |
| **CMG-1** | CVMS × Mid-Parental Growth Engine | `growth-prediction.html` | [ENGINE_GROWTH.md](./ENGINE_GROWTH.md) |
| **LPI-1** | Lateral Profile Interpolation Engine | `facial-simulation.html` | [ENGINE_FACIAL.md](./ENGINE_FACIAL.md) |
| **MFR-1** | Multi-Factor Relapse Prediction Engine | `recurrence-prediction.html` | [ENGINE_RECURRENCE.md](./ENGINE_RECURRENCE.md) |

---

## 공통 아키텍처

```
사용자 입력 → 룰베이스 사전 점수 (즉시) → Gemini 2.5 Flash 정밀 분석 (선택)
   ↓                                              ↓
시각화 카드 + 30단어 설명문                JSON structured output
   ↓                                              ↓
            결과 저장 → Supabase (patients + diagnoses + diagnosis-images)
```

### 공통 응답 스키마

```typescript
{
  score: number,            // 0-100
  recommendation: string,   // enum or text
  reasoning: string[],      // 5 한국어 근거
  risks: string[],          // 위험 요소
  alternatives: string[]    // 대안
}
```

엔진별 추가 필드:
- TSC-1: `teeth: string[]` (FDI 표기 권장 발치 치아)
- CMG-1: `remainingGrowthCm: number`, `skeletalStage: string`
- LPI-1: `facialChange: { profileShift, lipPosition, chinPosition }`
- MFR-1: `probabilities: { y1, y3, y5, y10 }`

---

## 룰베이스 → Gemini 핸드오프

각 엔진은 두 단계로 작동:

1. **룰베이스 사전 점수** (즉시, JS 실행)
   - 사용자가 입력 변경 시 자동 갱신
   - 시각화 카드와 점수 링에 즉시 반영

2. **Gemini 정밀 분석** (사용자 명시적 요청)
   - [🧠 Gemini AI 분석] 버튼 클릭
   - `/api/diagnose` POST → `gemini-2.5-flash` (responseMimeType: application/json)
   - 한국어 강제(KO_RULE), enum/숫자는 영문 유지
   - 5초 이내 응답, 폴백은 룰베이스 결과

---

## 신뢰도 (Confidence) 정책

- 본 엔진은 **임상 의사결정 보조 도구**이며 의료기기가 아님.
- 모든 출력은 자격을 갖춘 전문의 검토 후 사용.
- 룰베이스 점수 < Gemini 분석 < 의사 검토 (3단계)
- patient-detail.html에서 [✓ 수용] / [✗ 거부] / [📋 검토 완료] 워크플로우로 의사 판단 기록.

---

## 임상 근거 종합 (Evidence Base)

### 두부방사선 분석
- Tweed CH 1946 — Frankfort-Mandibular Plane
- Steiner CC 1953 — SNA·SNB·ANB
- Down WB 1948 — Facial relationships
- Andrews LF 1972 — Six keys to normal occlusion

### 골 성숙
- Baccetti T, Franchi L, McNamara JA Jr 2005 — CVMS Method
- Greulich WW, Pyle SI 1959 — Hand-wrist atlas
- Tanner JM, Whitehouse RH 1976 — Mid-parental height

### 안모 분석
- Ricketts RM 1968 — E-line
- Drobocky OB, Smith RJ 1989 — Soft tissue ratio
- Bishara SE 1998 — Long-term profile

### 재발
- Little RM 1975, 1988 — Irregularity index, post-retention
- Renkema AM 2008 — Bonded retainer effectiveness
- Sadowsky C 1982 — Long-term relapse

---

## 다음 단계 (V2 로드맵)

1. **자체 fine-tune 모델** — 한국인/아시아인 표준 두부방사선 데이터셋 10만 케이스
2. **CBCT 기반 3D 시뮬레이션** — Lateral 2D 한계 극복 (LPI-2)
3. **재발 ML 모델** — XGBoost/LightGBM 기반, AUC ≥ 0.85 목표 (MFR-2)
4. **EZL-STL 통합** — 3D 스캐너 자동 측정값과 룰베이스 직접 연결
5. **다국어 응답** — 한·영·일·중 자동 분기

---

## 변경 이력

- 2026-04-30 v1.0: 4 엔진 초안 작성, Gemini 2.5 Flash 통합, Supabase 저장 가동.

---

## 관련 문서

- [PRD (제품 요구사항)](../PRD.md)
- [AI 에이전트 20개 명세](../AI_AGENTS_20.md)
- [MVP → SaaS 로드맵](../MVP_TO_SAAS.md)
- [Neo4j 스키마](../NEO4J_SCHEMA.cypher)
