# 20-19 Orthodontics AI · 제품 요구사항 문서 (PRD)

| 항목 | 값 |
|---|---|
| 문서 버전 | 1.0 |
| 작성일 | 2026-04-30 |
| 상태 | Approved (MVP) |
| 책임자 | Product Lead |
| 대상 독자 | 개발팀 / 디자이너 / 임상자문 / RA(규제) / 영업·마케팅 |

---

## 목차

1. [개요 & Vision](#1-개요--vision)
2. [시장 분석](#2-시장-분석)
3. [페르소나](#3-페르소나)
4. [사용자 여정](#4-사용자-여정)
5. [기능 요구사항 (FR)](#5-기능-요구사항-fr)
6. [비기능 요구사항 (NFR)](#6-비기능-요구사항-nfr)
7. [AI 모델 요구사항](#7-ai-모델-요구사항)
8. [데이터 모델](#8-데이터-모델)
9. [API 명세](#9-api-명세)
10. [UI/UX 가이드라인](#10-uiux-가이드라인)
11. [보안 & 규정](#11-보안--규정)
12. [성능 목표](#12-성능-목표)
13. [출시 전략](#13-출시-전략)
14. [가격 정책](#14-가격-정책)
15. [마일스톤](#15-마일스톤)
16. [리스크](#16-리스크)
17. [부록](#17-부록)

---

## 1. 개요 & Vision

### 1.1 제품 개요
20-19 Orthodontics AI는 교정치과 의사의 **전체 임상 의사결정 사이클**(진단·계획·실행·모니터링·재발 예측)을 AI로 보조하는 SaaS 플랫폼이다. 4대 AI 엔진(발치 판단, 성장 예측, 안모 시뮬레이션, 재발 예측)과 EZL-STL 3D 측정 엔진, RAG 챗봇, Neo4j 지식그래프를 단일 워크플로우로 통합한다.

### 1.2 미션
> 교정치과 의사가 30분 만에 끝낼 수 있는 진단을 5분 만에, 더 정확하게.

### 1.3 비전
- **2년**: 한국 교정치과 1,000곳에서 매주 사용
- **5년**: 글로벌 5,000 클리닉, ARR $50M, 의료기기 인증 보유
- **10년**: "치과의 Palantir" — 모든 진료과로 확장된 의료 AI OS

### 1.4 핵심 가치 제안
1. **정확도**: AI 진단 정확도 95% 목표 (vs 전문의 panel)
2. **속도**: 진단 시간 80% 단축 (30분 → 5분)
3. **일관성**: 의사 간 진단 편차 60% 감소
4. **재발 감소**: 5년 재발률 30% 감소
5. **환자 만족도**: 시각화된 시뮬레이션으로 동의율↑

### 1.5 비목표 (Non-Goals, MVP 단계)
- 비교정 진료(보철, 임플란트)
- 환자용 모바일 네이티브 앱
- 의료기기 인증 (Beta SaaS 단계)
- 보험 청구 자동화 (운영 에이전트, GA 단계)

---

## 2. 시장 분석

### 2.1 시장 규모
- 글로벌 교정 시장: 2024 $5.2B → 2030 $12.4B (CAGR 15.7%)
- TAM: 글로벌 치과 클리닉 200만 곳 × $1,200 ARR = $2.4B
- SAM: 디지털 친화 30만 곳 × $2,000 = $600M
- SOM (5년): 5만 클리닉 × $2,400 = $120M

### 2.2 경쟁 분석
| 경쟁사 | 강점 | 약점 | 우리 차별점 |
|---|---|---|---|
| Align Technology (Invisalign + ClinCheck) | 시장 지배자, 자체 얼라이너 | 폐쇄 생태계 | 오픈 플랫폼 |
| 3Shape | 정밀 스캐너 + Ortho System | 하드웨어 중심 | AI/SW 우위 |
| Diagnocat | AI X-ray 분석 | 단일 모달 | End-to-end 통합 |
| Bone3D | CBCT 분석 | 진단만 | 진단+계획+모니터링 |
| Clearcorrect (Straumann) | 얼라이너 | AI 부재 | 4종 AI 엔진 |

### 2.3 트렌드
- **성인 교정 폭증** — 30-50대 미용 교정. 클리어얼라이너 시장 연 25% 성장
- **AI 의료 진단 수용성 증가** — 환자가 AI 시각화 자료 기대
- **DSO(Dental Service Organization) 통합** — 미국·유럽 클리닉 체인화로 SW 결정권 집중
- **규제 강화** — EU AI Act, FDA SaMD Pre-cert. 인증 = 진입 장벽

---

## 3. 페르소나

### 3.1 P1: 김원장 (45세, 클리닉 오너)
- 서울 강남 단독 클리닉 운영, 직원 8명
- 환자 월 100건, 신규 교정 환자 월 30건
- **고통**: 진단 시간 길고 의사마다 일관성 떨어짐. 환자가 다른 클리닉과 비교하며 결정 미룸.
- **목표**: 진단 시간 단축 + 시각화로 환자 동의율 ↑
- **의사결정 기준**: ROI (월 비용 vs 추가 케이스 전환), 한국어 지원, 임상 정확성

### 3.2 P2: 이선생 (32세, 부 의사)
- 대학병원 교정과 전임의
- **고통**: 전공의가 진단 도와주지만 본인 검증 시간 많이 걸림
- **목표**: 빠른 사전 분석 + 본인은 검수만
- **의사결정 기준**: 정확도, 학술적 근거, 데이터 export 용이성

### 3.3 P3: 박팀장 (28세, 데이터 분석가 / 클리닉 직원)
- 대형 DSO 본사 데이터 운영
- **고통**: 분원별 진단 품질 편차, 통합 대시보드 없음
- **목표**: 다 분원 진단 데이터 통합 분석
- **의사결정 기준**: API · CSV export, 멀티테넌시, 보안

### 3.4 P4: 최원장 (50세, 보수적 임상의)
- 25년 경력, AI 회의적
- **고통**: 직원 채용난, 환자 대기 시간 길어짐
- **목표**: 본인 진단을 검증해주는 조수 역할
- **의사결정 기준**: 의료법 합규성, 의사 최종 결정권 보장, 사용 약관

### 3.5 P5: 정환자 (28세, 교정 환자)
- IT 종사자, 클리어얼라이너 검토 중
- **고통**: 여러 클리닉 견적·계획 비교 어려움
- **목표**: 시각화된 결과 보고 결정
- **의사결정 기준**: 시뮬레이션 quality, 가격 투명성

---

## 4. 사용자 여정

### 4.1 신규 환자 진단 플로우
```
1. 접수 [P3 직원]
   └→ PatientIntake 폼: 이름·생년월일·연령·성별
   └→ 시스템: localStorage(MVP) 또는 Supabase(SaaS)

2. 데이터 수집 [P3 직원]
   ├→ 측면 두부방사선 촬영 → upload.html
   ├→ 파노라마 촬영 → upload.html
   └→ STL 모형 스캔 → 3d-viewer.html

3. AI 사전 분석 (자동)
   ├→ CephAnalyzer (1-2초)
   ├→ PanoAnalyzer (2-3초)
   └→ EZL-STL Engine (즉시)

4. 발치/성장/안모/재발 진단 [P2 의사]
   ├→ extraction-ai.html: 룰베이스 + Gemini 호출 (3-5초)
   ├→ growth-prediction.html: 어린이만
   ├→ facial-simulation.html: 환자 대화용
   └→ recurrence-prediction.html: 치료 종료 시점

5. 종합 치료계획 [P2 의사 + P1 원장]
   └→ TreatmentPlanner (Gemini Pro, 8-15초)

6. 환자 상담 [P1 원장]
   └→ 페이셜 시뮬레이션 + Before/After
   └→ 동의서 자동 생성 (ConsentDrafter)

7. 치료 시작 → 모니터링 (정기 방문)
   └→ ProgressMonitor (매 방문)
   └→ ComplicationDetector (이상 감지 시 알림)

8. 치료 종료 → 보정 + 재발 예측
   └→ RecurrencePredictor → 보정 프로토콜 결정
```

### 4.2 챗봇 활용 플로우
```
1. 임상의가 질문 → chatbot.html
2. RAG 검색 (pgvector 768d)
3. Gemini가 출처 포함 답변
4. 우측 패널: 인용 출처 표시
5. 임상의가 환자 차트와 함께 활용
```

---

## 5. 기능 요구사항 (FR)

### 5.1 진단 (FR-1 ~ FR-15)

| ID | 기능 | 우선순위 |
|---|---|---|
| FR-1 | 환자 등록·프로필 관리 (성인/어린이 자동 분기) | P0 |
| FR-2 | 측면 두부방사선 자동 분석 (SNA, SNB, ANB 등) | P0 |
| FR-3 | 파노라마 X-ray 치아 상태 분석 | P1 |
| FR-4 | STL 3D 모형 자동 측정 (EZL-STL) | P0 |
| FR-5 | 발치 판단 AI (룰베이스 + Gemini) | P0 |
| FR-6 | 성장 예측 AI (어린이) | P0 |
| FR-7 | 안모 변화 시뮬레이션 (실시간 SVG) | P0 |
| FR-8 | 재발 확률 예측 (1·3·5·10년) | P0 |
| FR-9 | 종합 치료계획 자동 생성 | P1 |
| FR-10 | 클리어얼라이너 단계 설계 | P2 |
| FR-11 | 브라켓 위치 최적화 | P2 |
| FR-12 | 와이어 벤딩 시뮬레이션 | P2 |
| FR-13 | 진척도 모니터링 (정기 방문 비교) | P1 |
| FR-14 | 합병증 조기 감지 | P1 |
| FR-15 | 진단 결과 PDF 리포트 출력 | P1 |

### 5.2 RAG 챗봇 (FR-16 ~ FR-22)

| ID | 기능 | 우선순위 |
|---|---|---|
| FR-16 | 자연어 질의응답 (한국어/영어) | P0 |
| FR-17 | 출처 인용 표시 | P0 |
| FR-18 | 모델 선택 (Flash/Pro/Vision) | P1 |
| FR-19 | 파일 첨부 (이미지/STL/PDF) 분석 | P0 |
| FR-20 | 대화 이력 저장·검색 | P1 |
| FR-21 | 빠른 질문 칩 (Quick prompts) | P2 |
| FR-22 | 음성 입력 (모바일) | P3 |

### 5.3 대시보드 (FR-23 ~ FR-30)

| ID | 기능 | 우선순위 |
|---|---|---|
| FR-23 | KPI 카드 (총 환자, 완료, 진행, 재발 알림) | P0 |
| FR-24 | 연령 분포 도넛 차트 | P0 |
| FR-25 | 진단 유형 분포 막대 | P0 |
| FR-26 | 월별 트렌드 라인 | P0 |
| FR-27 | 환자 목록 검색·필터 | P0 |
| FR-28 | CSV/Excel 내보내기 | P0 |
| FR-29 | PDF 리포트 일괄 생성 | P2 |
| FR-30 | 분원별 비교 대시보드 (DSO) | P3 |

### 5.4 SaaS 운영 (FR-31 ~ FR-50, Beta SaaS 단계)

| ID | 기능 | 우선순위 |
|---|---|---|
| FR-31 | 병원 회원가입 (이메일+OTP) | P0 |
| FR-32 | 다중 사용자·권한(Owner/Doctor/Staff/Admin) | P0 |
| FR-33 | SSO (Google, Microsoft) | P1 |
| FR-34 | 결제 (Stripe 정기 구독) | P0 |
| FR-35 | 사용량 미터링 (AI 호출 카운트) | P0 |
| FR-36 | 한도 초과 시 graceful degradation | P0 |
| FR-37 | 인보이스 자동 발행 | P1 |
| FR-38 | 다국어 (한·영·일·중) | P1 |
| FR-39 | 다크모드 / 라이트모드 토글 | P2 |
| FR-40 | 모바일 PWA | P1 |
| FR-41 | DICOM 게이트웨이 | P2 (GA) |
| FR-42 | HL7 FHIR API | P2 (GA) |
| FR-43 | 감사 로그 7년 보존 | P0 |
| FR-44 | 데이터 export (전체 내보내기) | P1 |
| FR-45 | 개별 환자 데이터 삭제 (GDPR) | P0 |
| FR-46 | 클리닉별 브랜딩 (logo/color) | P2 |
| FR-47 | API 키 발급 (External integration) | P2 |
| FR-48 | Webhook (진단 완료 시) | P2 |
| FR-49 | 환자 직접 로그인 (homecare) | P3 |
| FR-50 | 다 분원 통합 대시보드 (Enterprise) | P2 |

---

## 6. 비기능 요구사항 (NFR)

### 6.1 성능 (NFR-1 ~ NFR-5)
| ID | 요구사항 | 목표 |
|---|---|---|
| NFR-1 | 페이지 로드 시간 (FCP) | < 1.5초 |
| NFR-2 | AI 진단 응답 (Gemini Flash) | < 5초 |
| NFR-3 | AI 진단 응답 (Gemini Pro) | < 15초 |
| NFR-4 | RAG 검색 (pgvector 100K chunks) | < 200ms |
| NFR-5 | STL 50MB 로드·렌더링 | < 4초 |

### 6.2 가용성 (NFR-6 ~ NFR-9)
| ID | 요구사항 | 목표 |
|---|---|---|
| NFR-6 | 시스템 가용성 SLA | 99.9% (월 43분 다운) |
| NFR-7 | RPO (Recovery Point) | 5분 |
| NFR-8 | RTO (Recovery Time) | 1시간 |
| NFR-9 | 데이터 백업 주기 | 일 1회 + 트랜잭션 로그 |

### 6.3 확장성 (NFR-10 ~ NFR-13)
| ID | 요구사항 | 목표 |
|---|---|---|
| NFR-10 | 동시 사용자 (Beta) | 1,000 |
| NFR-11 | 동시 사용자 (GA) | 100,000 |
| NFR-12 | 일 진단 처리량 | 50,000 건 |
| NFR-13 | 환자 데이터 저장 한도 | 무제한 (페이지네이션) |

### 6.4 보안 (NFR-14 ~ NFR-22)
| ID | 요구사항 |
|---|---|
| NFR-14 | TLS 1.3 강제 |
| NFR-15 | Database encryption at rest (AES-256) |
| NFR-16 | RLS (Row-Level Security) by clinic_id |
| NFR-17 | API rate limiting (사용자별 100 req/min) |
| NFR-18 | OWASP Top 10 대응 |
| NFR-19 | 분기별 펜테스트 |
| NFR-20 | MFA (TOTP, SMS) |
| NFR-21 | API 키 rotation (90일) |
| NFR-22 | 비밀번호 정책 (12자+, 복잡도) |

### 6.5 규정 준수 (NFR-23 ~ NFR-26)
| ID | 표준 | 단계 |
|---|---|---|
| NFR-23 | HIPAA (BAA) | Beta SaaS |
| NFR-24 | GDPR | Beta SaaS |
| NFR-25 | ISO 27001 | GA |
| NFR-26 | SaMD 의료기기 인증 (식약처 Class II) | GA |

### 6.6 접근성 (NFR-27 ~ NFR-30)
| ID | 요구사항 |
|---|---|
| NFR-27 | WCAG 2.1 AA 준수 |
| NFR-28 | 키보드만으로 모든 기능 접근 |
| NFR-29 | 색맹 친화 (Deuteranopia/Protanopia) |
| NFR-30 | 화면 낭독기 (NVDA, JAWS) 지원 |

---

## 7. AI 모델 요구사항

### 7.1 발치 판단 AI (ExtractionDecider)
- **베이스 모델**: Gemini 1.5 Flash
- **입력**: ANB, Crowding, Overjet, Profile, Lip strain, FMA, IMPA, 환자 연령군
- **출력 (JSON 강제)**:
  ```json
  {"score": 0-100, "recommendation": "extract|non_extract|borderline",
   "teeth": ["14","24","34","44"], "reasoning": [...], "risks": [...], "alternatives": [...]}
  ```
- **정확도 목표**: 전문의 panel 일치도 ≥ 85%
- **fallback**: 룰베이스 (Tweed/Steiner/Down 종합 점수)

### 7.2 성장 예측 AI (GrowthPredictor)
- **베이스 모델**: Gemini 1.5 Flash + 통계 모델 (Mid-parental + CVMS)
- **입력**: 신장, 부모 키, 성별, 골연령, CVMS
- **출력**: 잔여 성장량(cm), 골성숙 단계, 권장 시기, peak age
- **검증**: 한국인 표준 성장 데이터셋과 RMSE ≤ 1.5cm

### 7.3 안모 시뮬레이션 (FacialSimulator)
- **방식**: 클라이언트 SVG 보간 + Gemini Vision (선택)
- **랜드마크 5종**: N, Sn, A, B, Pog, Me
- **E-line 측정 정확도**: ±0.5mm

### 7.4 재발 예측 AI (RecurrencePredictor)
- **베이스 모델**: 가중 합산 + Gemini
- **입력**: IMPA, 보정장치 종류, 협조도, 보정 기간, 잔여 crowding
- **출력**: 1·3·5·10년 누적 재발 확률
- **검증**: 5년 follow-up 데이터셋과 AUC ≥ 0.80

### 7.5 RAG 챗봇 (KnowledgeCurator)
- **임베딩**: text-embedding-004 (768차원)
- **검색**: pgvector IVFFlat, top-3, similarity threshold 0.5
- **답변**: Gemini 1.5/2.0, 출처 인용 강제
- **재인덱싱**: 주 1회 (Vercel Cron)

### 7.6 모델 거버넌스
- 모든 모델은 버전 태그 (`v1.0-Pediatric-Growth`)
- 진단 결과에 모델 버전 함께 저장
- 인증 후 모델 변경은 새 버전으로 별도 관리
- 사용자에게 "AI 자신감(confidence)" 표시 (0-100%)

---

## 8. 데이터 모델

### 8.1 ERD
```
clinics (1) ──< (N) users
clinics (1) ──< (N) patients
patients (1) ──< (N) diagnoses
diagnoses (N) >── (1) treatment_plans (선택)
users (1) ──< (N) conversations
knowledge_chunks (N) (글로벌)
```

### 8.2 주요 테이블

#### `clinics`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| name | text | 병원명 |
| doctor | text | 원장명 |
| email | text UNIQUE | 로그인용 |
| phone | text | |
| region | text | 시/도 |
| tier | text | free/pro/clinic/enterprise |
| created_at | timestamptz | |

#### `patients`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| clinic_id | uuid FK | RLS 키 |
| name | text | (개인정보 보호: 가능하면 가명화) |
| dob | date | |
| age_group | text | child/adult |
| gender | text | |
| metadata | jsonb | 의료력, 특이사항 |

#### `diagnoses`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| patient_id | uuid FK | |
| type | text | extraction/growth/facial/recurrence |
| inputs | jsonb | 사용자 입력값 |
| result | jsonb | AI 출력 (score, reasoning, risks 등) |
| model_version | text | 모델 추적용 |
| created_at | timestamptz | |

#### `knowledge_chunks` (RAG)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| content | text | 본문 |
| embedding | vector(768) | text-embedding-004 |
| source | text | 출처 (논문 DOI, 가이드라인) |
| metadata | jsonb | year, authors 등 |

상세 스키마: [`db/schema.sql`](../db/schema.sql)

---

## 9. API 명세

### 9.1 POST `/api/chat`
**요청**:
```json
{
  "messages": [{"role": "user", "content": "Bolton 비율 91.3%의 의미는?"}],
  "model": "gemini-1.5-flash",
  "userId": "u_abc"
}
```
**응답**:
```json
{
  "reply": "Bolton 비율 91.3%는...",
  "sources": [{"source": "Proffit 2023", "snippet": "..."}],
  "usage": {"model": "gemini-1.5-flash"}
}
```

### 9.2 POST `/api/diagnose`
**요청**:
```json
{
  "type": "extraction",
  "patient": {"id": "P1001", "ageGroup": "adult"},
  "inputs": {"crowding": 6.5, "anb": 4.2, ...},
  "save": true
}
```
**응답**: ExtractionDecider JSON 스키마와 동일.

### 9.3 POST `/api/upload`
**요청**:
```json
{"filename":"lateral.png","base64":"...","contentType":"image/png","clinicId":"c_xyz"}
```
**응답**:
```json
{"filename":"lateral.png","url":"https://...","analysis":"..."}
```

### 9.4 GET `/api/clinics`
1시간 캐시. mock 폴백.

### 9.5 GET `/api/cron/reindex`
주 1회 Vercel Cron이 호출. RAG 임베딩 갱신.

전체 명세: 페이지별 인라인 주석 + Postman/OpenAPI 별도 문서 (Beta SaaS).

---

## 10. UI/UX 가이드라인

### 10.1 디자인 토큰
| 토큰 | 값 |
|---|---|
| Primary | `#0EA5E9` |
| Accent | `#8B5CF6` |
| Bg | `#0B1220` |
| Surface | `#111827` |
| Text Primary | `rgba(229,231,235,1.0)` |
| Text Secondary | `rgba(229,231,235,0.72)` |
| Text Muted | `rgba(229,231,235,0.5)` |
| Radius | 14-24px |
| Font | Pretendard / Inter |

### 10.2 컴포넌트 라이브러리
- Card (`.card`)
- Button (`.btn` + `-primary` / `-ghost` / `-sm` / `-lg`)
- Badge (5종)
- Input / Select / Textarea
- Modal (`.modal-backdrop` + `.modal`)
- Toast (`.toast` 4종)
- Sidebar (`.sidebar`)

### 10.3 반응형 Breakpoint
- 모바일: `< 640px`
- 태블릿: `640-1024px`
- 데스크톱: `> 1024px`

### 10.4 텍스트 투명도 계층
- Primary: 1.0 — 핵심 정보 (제목, 결과 수치)
- Secondary: 0.72 — 본문, 보조 정보
- Muted: 0.5 — 메타, 라벨, placeholder

### 10.5 인터랙션 원칙
- 모든 액션은 200-300ms 전이
- 위험한 액션(삭제 등)은 confirm 모달
- AI 호출은 typing indicator 또는 progress bar
- 에러는 toast로, 즉시 무시 가능

### 10.6 접근성
- 모든 인터랙티브 요소는 `aria-label`
- 폼 필드는 `<label for>`
- 키보드 포커스 가시화 (`:focus-visible`)
- 색상만으로 정보 전달 금지 (아이콘/텍스트 병기)

---

## 11. 보안 & 규정

### 11.1 데이터 분류
| 등급 | 예시 | 처리 |
|---|---|---|
| 매우 민감 (PHI) | 환자 이름, DOB, 진단 결과 | 암호화 + RLS + 감사 |
| 민감 | 클리닉 정보, 사용자 이메일 | 암호화 + RLS |
| 내부 | 운영 통계 | 인증 사용자 |
| 공개 | 매뉴얼, 가격 | 누구나 |

### 11.2 PHI 보호 (HIPAA, Beta SaaS)
- BAA 체결: Vercel, Supabase, Google (Gemini), Stripe
- 환자 ID는 가능한 한 가명화 (`P_uuid`)
- 진단 로그에서 직접 식별 정보 제외
- Cross-region 전송 시 암호화 + 사용자 동의

### 11.3 GDPR (EU)
- 데이터 주체 권리: 조회/수정/삭제/이동
- 14일 내 처리 + 자동화 도구 제공
- DPO(Data Protection Officer) 지정
- ROPA(Record of Processing) 유지

### 11.4 의료기기 인증 로드맵
| 단계 | 표준 | 시점 |
|---|---|---|
| 1 | 식약처 SaMD Class II | M+12 신청 |
| 2 | CE Mark MDR Class IIa | M+18 |
| 3 | FDA 510(k) | M+24 |
| 4 | PMDA (일본) | M+30 |

### 11.5 임상 검증
- 회고적 검증: 5,000 케이스, 전문의 panel 일치도
- 전향적 검증: 1,000 케이스, RCT 수준 (필수)
- 발표: KSO(대한치과교정학회), AAO(American Association of Orthodontists)

---

## 12. 성능 목표

| 메트릭 | 목표 | 측정 방법 |
|---|---|---|
| FCP (First Contentful Paint) | < 1.5초 | Lighthouse |
| LCP (Largest Contentful Paint) | < 2.5초 | Web Vitals |
| TTI (Time to Interactive) | < 3.5초 | Lighthouse |
| API p95 (Gemini Flash) | < 5초 | Datadog |
| API p99 (Gemini Pro) | < 20초 | Datadog |
| RAG 검색 p95 | < 200ms | Postgres EXPLAIN |
| 동시 진단 처리 | 100 req/sec | k6 부하 테스트 |

---

## 13. 출시 전략

### 13.1 단계별 롤아웃
**알파 (M0-M3)**
- 5개 클리닉 (서울 강남 3, 부산 1, 대구 1)
- 무료 + 주 1회 피드백 인터뷰
- 진단 200건 목표

**베타 (M3-M9)**
- 100 클리닉, Free + Pro 30일 무료
- Stripe 결제 정식 도입
- NPS·Churn 추적
- ARR $500K 목표

**일반 (GA, M9+)**
- 무제한 가입
- Public 마케팅 (네이버 지식백과, 학회 부스)
- ARR $5M (Year 2 말) 목표

### 13.2 마케팅 채널
- **학회**: KSO 춘계/추계, AAO Annual Session
- **데모**: 치과 박람회 (KIDEX, IDS Cologne)
- **콘텐츠**: 임상 케이스 블로그, YouTube
- **B2B 영업**: DSO 본사 (Heartland, Aspen, Nava 등) 직접 영업
- **추천**: 사용자 추천 시 1개월 무료

### 13.3 가격 책정 전략
- Free 플랜으로 진입 마찰 제거
- Pro 무료 30일 → 자연 전환 30%+ 목표
- DSO 협상 시 Enterprise (10% 할인 시작)

---

## 14. 가격 정책

| 플랜 | 월 요금 | 환자 케이스 | AI 호출 | 사용자 | 핵심 기능 |
|---|---|---|---|---|---|
| **Free** | $0 | 5/월 | 50/월 | 1 | 4종 AI, 3D 뷰어, 챗봇 (Flash) |
| **Pro** | $99 | 50/월 | 1,000/월 | 3 | + Gemini Pro, 대시보드, CSV |
| **Clinic** | $499 | 무제한 | 10,000/월 | 10 | + RLS, DICOM, 우선 지원 |
| **Enterprise** | 협의 | 무제한 | 무제한 | 무제한 | + 전용 fine-tune, SLA, 전담 매니저 |

**오버에이지**: AI 호출 한도 초과 시 $0.05/회.
**연 결제 할인**: 2개월 무료.
**비영리/교육 할인**: 50%.

---

## 15. 마일스톤

```
2026 Q2 (M0)  : MVP 코드 완성, 5 클리닉 PoC 시작
2026 Q3 (M3)  : 진단 200건. SaaS 설계 동결. Series Pre-A $5M.
2026 Q4 (M6)  : Beta 알파 출시. RLS + Stripe + Auth.
2027 Q1 (M9)  : Beta GA. 100 클리닉. ARR $500K.
2027 Q3 (M15) : 식약처 인증 신청. 1,000 클리닉.
2027 Q4 (M18) : DICOM/FHIR + 모바일 PWA.
2028 Q2 (M24) : GA SaaS 글로벌 출시. ARR $5M.
2028 Q4 (M30) : FDA 510(k) 신청. Series A $20M.
2029-2030     : 5,000 클리닉, ARR $50M, Series B $80M.
2031-2035     : 인접 진료과 확장, IPO 또는 인수, 시가총액 1조.
```

---

## 16. 리스크

| ID | 리스크 | 가능성 | 영향 | 완화책 |
|---|---|---|---|---|
| R1 | Gemini 가격 인상 | 중 | 높음 | 자체 fine-tune 가속, 멀티 프로바이더 |
| R2 | 의료기기 인증 지연 | 높음 | 중 | RA 전문가 조기 영입 |
| R3 | 빅테크 진입 (Google/Microsoft) | 중 | 매우 높음 | 한국·아시아 데이터 lock-in |
| R4 | 의료사고 책임 | 낮음 | 매우 높음 | "임상 보조 도구" 명시, 보험 |
| R5 | 데이터 유출 | 낮음 | 매우 높음 | HIPAA BAA, 펜테스트 |
| R6 | 클리닉 SW 도입 저항 | 중 | 중 | KOL 영향력 활용, 한국치과교정학회 협력 |
| R7 | 환율 변동 (글로벌 진출) | 중 | 중 | 자연 헤징 (USD 매출 비중↑) |
| R8 | 핵심 인력 이탈 | 낮음 | 높음 | RSU 4년 베스팅, 문화 |

---

## 17. 부록

### 17.1 용어집
| 용어 | 의미 |
|---|---|
| **ANB** | A point-Nasion-B point 각도. 골격 관계 진단. |
| **Bolton 비율** | 상하악 치아 너비 비율. 전치 77.2%, 전체 91.3%. |
| **CVMS** | Cervical Vertebral Maturation Stage. 1-6단계. |
| **EZL-STL** | Engineered Zoom Level STL 측정 엔진 (자체 명명). |
| **FDI** | 국제치과연맹 치아 번호 시스템 (11-48). |
| **IMPA** | Incisor Mandibular Plane Angle. 하악 절치 경사도. |
| **PHI** | Protected Health Information. HIPAA 보호 정보. |
| **RAG** | Retrieval-Augmented Generation. 검색증강생성. |
| **RLS** | Row-Level Security. Postgres 행 단위 보안. |
| **SaMD** | Software as a Medical Device. 의료기기 SW 등급. |
| **Spee 만곡** | Curve of Spee. 교합면 곡선 깊이. |
| **TAD** | Temporary Anchorage Device. 미니 임플란트. |
| **TMD** | Temporomandibular Disorder. 측두하악관절 장애. |
| **Tweed** | Tweed 분석. FMA + IMPA 기반 진단법. |
| **Steiner** | Steiner 분석. SNA·SNB·ANB 종합 분석. |

### 17.2 참고 문헌
1. Proffit WR. *Contemporary Orthodontics*, 6th ed. Elsevier, 2018.
2. Graber TM, et al. *Orthodontics: Current Principles and Techniques*, 6th ed. Elsevier, 2017.
3. Baccetti T, et al. "An Improved Version of the Cervical Vertebral Maturation Method." *Angle Orthod*, 2005.
4. Bolton WA. "Disharmony in tooth size and its relation to malocclusion." *Angle Orthod*, 1958.
5. Andrews LF. "The six keys to normal occlusion." *Am J Orthod*, 1972.
6. Tweed CH. "The Frankfort-Mandibular Plane Angle in Orthodontic Diagnosis." *Angle Orthod*, 1946.
7. Steiner CC. "Cephalometrics for you and me." *Am J Orthod*, 1953.
8. Ricketts RM. "Esthetics, environment, and the law of lip relation." *Am J Orthod*, 1968.

### 17.3 변경 이력
| 버전 | 날짜 | 변경 내용 | 작성자 |
|---|---|---|---|
| 0.1 | 2026-04-30 | 초안 작성 | Product Lead |
| 1.0 | 2026-04-30 | MVP 승인 | Product + Eng + 임상자문 |

### 17.4 승인
- [ ] 제품 책임자: ________________
- [ ] 엔지니어링 리드: ________________
- [ ] 임상 자문: ________________
- [ ] 규제 책임자: ________________
- [ ] 보안 책임자: ________________
