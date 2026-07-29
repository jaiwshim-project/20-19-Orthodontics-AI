# Orthodontics AI Development Planning

작성일: 2026-06-16

## 1. 기획 결론

현재 프로젝트는 일반적인 "교정 AI 진단 플랫폼"에서 한 단계 더 좁혀야 한다. 핵심 제품은 **EZ/TZ 기반 발치/비발치 의사결정 보조 도구**로 정의하는 것이 맞다.

즉, 단순히 Gemini 또는 Azure OpenAI가 발치 여부를 답하는 서비스가 아니라, 다음 질문에 답하는 임상 계측 시스템이어야 한다.

> 현재 치아 배열(TZ)을 안정적인 평형 영역(EZ)에 넣기 위해 공간이 충분한가, 부족한가, 부족하다면 발치/공간 확보 검토가 필요한가?

따라서 MVP의 중심은 자동 AI가 아니라 **의사가 직접 보정 가능한 반자동 계측 워크플로우**다. AI는 초기에는 설명, 요약, 리포트, 유사 케이스 검색을 보조하고, 충분한 라벨 데이터가 쌓인 뒤 landmark/curve 자동 제안으로 확장한다.

## 2. 현재 구현 상태

이미 구현된 범위:

- 정적 HTML 기반 앱 구조
- Vercel Serverless API
- Supabase 기반 환자/진단 저장 구조
- Gemini 기반 기존 AI 진단 API
- Azure OpenAI 우선 사용 어댑터
- `equilibrium-analysis.html` 초기 화면
- `js/equilibrium-zone-engine.js` EZ/TZ 곡선 길이 계산 엔진
- `js/curve-editor.js` Canvas 기반 control point 입력 도구
- `api/save-equilibrium-analysis.js` 분석 저장 API
- `db/20260616_equilibrium_analyses.sql` 신규 분석 테이블

현재 부족한 범위:

- 화면 문구 인코딩 깨짐 정리
- 상악/하악 이미지 전환 UX 고도화
- PM 기준 스케일 보정 플로우
- Ceph 보정값 입력 패널
- 분석 이력 조회 API
- 리포트 생성 화면
- 유사 케이스 검색
- 데이터셋/라벨링 운영 구조
- 임상 검증 지표와 QA 기준

## 3. 제품 포지셔닝

제품명 후보:

- EZ/TZ Equilibrium Analyzer
- Orthodontic Extraction Decision Assistant
- 20-19 Equilibrium Planner

1차 타깃:

- 교정치과 원장
- 교정과 전공의/펠로우
- 케이스 리뷰를 많이 하는 치과 네트워크

핵심 가치:

- 발치/비발치 판단 근거를 시각화한다.
- 환자 상담 시 설명 가능한 자료를 만든다.
- 의사 판단과 계측 데이터를 함께 저장해 향후 AI 학습 데이터셋을 만든다.
- "AI가 진단했다"가 아니라 "의사의 판단 과정을 계측, 기록, 보조했다"로 규제 리스크를 낮춘다.

## 4. MVP 범위

MVP는 다음 5개 기능만 제대로 완성한다.

1. 케이스 생성
2. 5방향 구강사진/교합면 사진 업로드
3. EZ/TZ control point 입력 및 곡선 길이 계산
4. PM 또는 수동 기준을 통한 mm 스케일 보정
5. discrepancy 기반 발치/비발치/경계 케이스 리포트 생성

MVP에서 제외할 것:

- 완전 자동 landmark 검출
- CBCT/DICOM 정식 연동
- 의료기기 인증 수준의 자동 진단
- 환자용 모바일 앱
- 결제/구독/멀티테넌트 SaaS

## 5. 핵심 워크플로우

### Step 1. 케이스 등록

입력:

- 환자 코드
- 나이
- 성별
- 성장 단계
- 주소증

출력:

- case id
- 환자/분석 레코드

### Step 2. 자료 업로드

필수:

- 정면 구강사진
- 우측 측면 구강사진
- 좌측 측면 구강사진
- 상악 교합면 사진
- 하악 교합면 사진

선택:

- lateral ceph
- PM 이미지 또는 PM 측정값
- STL

### Step 3. 스케일 보정

MVP에서는 자동 스케일 추정을 하지 않는다.

지원 방식:

- PM 기준 px/mm 입력
- known tooth width 기준 보정
- 수동 기준선 길이 입력

결과:

- pxPerMm
- scale confidence
- scale source

### Step 4. EZ/TZ 커브 입력

의사가 상악/하악 각각에 대해 control point를 찍는다.

- TZ: 현재 치아 배열 contour
- EZ: 안정적인 평형 영역으로 예상되는 목표 contour

시스템은 Catmull-Rom spline으로 곡선을 샘플링하고 길이를 계산한다.

### Step 5. 보정값 입력

Ceph/임상 보정 인자:

- profile: protrusive / balanced / retrusive
- incisor inclination: proclined / normal / retroclined
- periodontal risk
- growth potential
- vertical pattern

### Step 6. 결과 판정

기본 규칙:

- 0-2mm: 비발치 가능성 높음
- 2-6mm: 경계 케이스
- 6mm 이상: 발치 또는 적극적 공간 확보 검토

단, ceph/안모/치주/성장 보정 인자로 adjusted discrepancy를 별도 산출한다.

### Step 7. 저장 및 리포트

저장 데이터:

- 원본 이미지 메타데이터
- EZ/TZ control points
- curve sample points
- 상악/하악 discrepancy
- ceph modifiers
- decision
- expert label
- notes

리포트 구성:

- 환자 정보
- 입력 자료 요약
- 상악/하악 EZ/TZ overlay
- discrepancy 표
- 보정 인자
- 판정 결과
- 의사 최종 판단란

## 6. 데이터 모델 보강안

현재 `equilibrium_analyses` 테이블은 방향이 맞다. 다음 필드를 추가 고려한다.

```sql
alter table equilibrium_analyses
  add column if not exists case_code text,
  add column if not exists status text default 'draft',
  add column if not exists report jsonb default '{}'::jsonb,
  add column if not exists model_version text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewer_id uuid;
```

필요 API:

- `GET /api/get-equilibrium-analyses?patientId=...`
- `GET /api/get-equilibrium-analysis?id=...`
- `POST /api/generate-equilibrium-report`
- `POST /api/update-equilibrium-label`
- `POST /api/search-similar-cases`

## 7. 개발 우선순위

### P0. 제품 사용 가능 상태 만들기

목표: 실제 샘플 케이스 1개로 처음부터 저장까지 완료.

작업:

- 깨진 한글 문구 복구
- `equilibrium-analysis.html` UX 정리
- 상악/하악 독립 편집 안정화
- 저장 결과 표시 개선
- 저장 실패 시 localStorage fallback 명확화
- Supabase SQL 적용 체크리스트 작성

완료 기준:

- 샘플 사진 업로드
- EZ/TZ 점 입력
- mm discrepancy 산출
- 분석 저장
- 새로고침 후 로컬 기록 유지

### P1. 임상 리포트 MVP

목표: 원장이 환자 상담에 쓸 수 있는 1페이지 리포트.

작업:

- `equilibrium-report.html` 추가
- 분석 결과 조회 API 추가
- canvas overlay 이미지 export
- PDF/print CSS
- 의사 최종 판단/메모 영역 추가

완료 기준:

- 분석 저장 후 리포트 열기
- 상악/하악 overlay 포함
- 발치/비발치/경계 판정 근거 표시
- 브라우저 인쇄로 PDF 저장 가능

### P2. 라벨링과 데이터셋 축적

목표: 향후 자동화 AI 학습을 위한 라벨 데이터 구조 확보.

작업:

- `case-labeling.html`
- expert decision 입력
- 치료 결과/재발 여부 입력
- 데이터 품질 등급 A/B/C
- CSV/JSON export

완료 기준:

- 케이스별 expert label 저장
- 100건 라벨링 가능한 운영 흐름
- export 파일로 외부 분석 가능

### P3. Ceph/PM 통합

목표: discrepancy 판정을 임상 보정값으로 보강.

작업:

- Ceph 수동 입력 패널
- PM tooth width 입력
- scale confidence 표시
- 보정 로직 버전 관리

완료 기준:

- 같은 discrepancy라도 안모/치축/치주 위험에 따라 adjusted decision 변경
- 결과 화면에 raw vs adjusted discrepancy 분리 표시

### P4. AI 보조 자동화

목표: 의사가 찍은 데이터를 기반으로 AI가 후보를 제안.

작업:

- Azure/OpenAI/Gemini provider별 호출 안정화
- 사진 유형 자동 분류
- TZ 후보 곡선 제안
- 유사 케이스 검색
- 리포트 문장 자동 생성

완료 기준:

- AI 제안은 항상 수정 가능
- confidence 표시
- 의사 승인 전에는 최종 판단으로 저장하지 않음

## 8. 리스크와 대응

### 인코딩 리스크

현재 문서와 일부 HTML/JS 문구가 깨져 있다. 기능이 동작해도 제품 신뢰도가 크게 떨어진다.

대응:

- 사용자 화면 문구 우선 복구
- README/개발계획 문서는 별도 UTF-8 정상본 생성
- 코드 내부 깨진 주석은 기능 안정화 후 정리

### 임상 책임 리스크

발치/비발치 판단은 고위험 임상 의사결정이다.

대응:

- "최종 진단"이 아니라 "의사결정 보조"로 표현
- 의사 최종 판단 필드 필수화
- AI confidence와 근거 표시
- 자동 판단 저장 금지, 승인 기록 저장

### 데이터 품질 리스크

사진 각도, 스케일, PM 품질이 낮으면 mm 계측 신뢰도가 떨어진다.

대응:

- scale confidence 표시
- 이미지 품질 체크리스트
- 데이터 등급 A/B/C 운영
- 불충분 데이터는 판정 대신 "추가 자료 필요" 표시

### SaaS 확장 리스크

현재는 정적 HTML MVP라 멀티테넌트/권한/감사 로그가 약하다.

대응:

- MVP에서는 단일 클리닉 PoC로 제한
- Beta 전환 시 Supabase Auth/RLS/Audit log를 먼저 구현
- PHI 저장 범위 최소화

## 9. 4주 실행 계획

### Week 1

- 깨진 한글 UI 복구
- equilibrium-analysis 화면 구조 정리
- 저장 API와 DB SQL 실제 적용 검증
- 샘플 케이스 1건 end-to-end 테스트

### Week 2

- 리포트 화면 추가
- overlay 이미지 export
- print/PDF 스타일 추가
- raw/adjusted discrepancy 분리 표시

### Week 3

- 라벨링 화면 추가
- expert decision 저장
- 데이터 품질 등급 추가
- CSV/JSON export 추가

### Week 4

- Ceph/PM 보정 패널 추가
- 유사 케이스 검색 설계
- PoC용 데모 시나리오 3건 제작
- 임상 검증 체크리스트 작성

## 10. 최종 기획 방향

이 프로젝트는 당장 "완전 자동 교정 AI"를 만들면 위험하고 설득력이 약하다. 반대로 **의사가 직접 검증할 수 있는 EZ/TZ 계측 도구**로 시작하면 임상 신뢰, 데이터 축적, SaaS 확장성이 모두 생긴다.

따라서 다음 개발 목표는 다음 한 문장으로 고정한다.

> 4주 안에, 교정의가 5방향 구강사진과 PM 기준값을 넣고 EZ/TZ discrepancy를 계산해 발치/비발치 판단 근거 리포트를 만들 수 있는 PoC를 완성한다.
