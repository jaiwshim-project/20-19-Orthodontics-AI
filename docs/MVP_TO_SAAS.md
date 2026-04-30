# MVP → SaaS 전환 구조

> 20-19 Orthodontics AI를 클리닉 단일 사용 MVP에서 글로벌 멀티테넌트 SaaS로 진화시키는 18개월 로드맵.

---

## 0. 한 줄 요약

**MVP**: 정적 HTML + Vercel Functions + Gemini + Supabase. 단일 테넌트.
**SaaS**: 멀티테넌트 + 빌링 + 권한 + SSO + DICOM 게이트웨이 + 의료기기 인증.

---

## 1. MVP (현재 빌드 범위)

### 포함
- 정적 페이지 8종 (Hub, 3D Viewer, AI 4종, Chatbot, Dashboard, Manual, Architecture)
- API 5종 (chat, diagnose, upload, clinics, cron/reindex)
- AI 엔진: Gemini 1.5/2.0 Flash, Pro, Vision, embedding-004
- DB: Supabase Postgres + pgvector (단일 인스턴스)
- 환자 컨텍스트: localStorage (브라우저 단위)
- 인증: 환경변수 ADMIN_DASH_PASS 단일 비밀번호

### 제외 (의도적 단순화)
- 사용자 회원가입·다중 사용자
- 빌링·결제
- 권한 모델 (Owner/Doctor/Staff)
- DICOM/HL7 FHIR 연동
- Audit log·HIPAA 컴플라이언스
- 모바일 네이티브 앱

### MVP 성공 지표 (3개월)
- 5개 클리닉 PoC 운영
- 진단 200건 이상
- 환자 만족도 4.0/5.0
- AI 진단 vs 임상의 일치도 80% 이상

---

## 2. Beta SaaS (M+3 ~ M+9)

### 신규 기능
1. **멀티테넌시**
   - Postgres RLS 정책 활성화 (`clinic_id` 기반)
   - Supabase Auth 통합 (이메일/구글 로그인)
   - 테넌트별 Storage 버킷 분리
2. **빌링·요금제**
   - Stripe 연동 (정기 구독)
   - 3개 플랜: Free 5케이스/월, Pro $99 50케이스, Clinic $499 무제한
   - 사용량 미터링 (Postgres `usage_events` 테이블)
   - 한도 초과 시 graceful degradation (룰베이스 폴백)
3. **권한 모델**
   - 4단계: Owner / Doctor / Staff / Admin
   - 페이지·API별 RBAC
4. **사용자 회원가입**
   - 병원 등록 → 원장 계정 생성 → 직원 초대
   - 이메일 검증 + 휴대폰 OTP
5. **감사 로그**
   - 모든 진단 호출, 환자 데이터 조회 이벤트 기록
   - 7년 보존 정책
6. **간단 모바일 최적화**
   - 모든 페이지 모바일 우선 재설계
   - PWA 지원 (offline 진단 fallback)

### Beta 성공 지표
- 50개 클리닉 유료 전환
- ARR $200K
- NPS > 30

---

## 3. GA SaaS (M+9 ~ M+18)

### 신규 기능
1. **DICOM 게이트웨이**
   - 병원 PACS 시스템과 직접 연동
   - DICOM Modality Worklist 지원
   - Lateral Ceph, Pano, CBCT 자동 가져오기
2. **HL7 FHIR API**
   - Patient/Observation/DiagnosticReport 리소스 노출
   - SMART-on-FHIR 지원 (EMR 통합)
3. **모바일 네이티브 앱**
   - React Native (iOS/Android)
   - 환자용: 진척도 확인, 사진 제출, 알림
4. **의료기기 인증**
   - 식약처 SaMD Class II
   - FDA 510(k) (북미 진출 시)
   - CE Mark MDR Class IIa (유럽)
5. **AI 모델 고도화**
   - 자체 fine-tune (Gemini 또는 Llama 3 기반)
   - 한국인 표준 두부방사선 데이터셋 (10만 케이스)
   - 진단 정확도 95% 이상
6. **인프라 진화**
   - Vercel → Vercel + 전용 GPU 클러스터 (자체 모델 추론용)
   - Supabase Free → Enterprise (HIPAA, dedicated)
   - Neo4j Aura Pro
   - Cloudflare Workers (Edge AI 부분 추론)

### GA 성공 지표
- 5,000개 클리닉 (글로벌)
- ARR $50M
- 의료기기 인증 1개 이상 보유
- AI 진단 정확도 95%

---

## 4. 인프라 진화도

```
[MVP]                          [Beta SaaS]                    [GA SaaS]
─────                          ───────────                    ─────────
Vercel (정적)                  Vercel + Cron                  Vercel + GPU 클러스터
Supabase Free                  Supabase Pro                   Supabase Enterprise + HIPAA
Gemini API (공유)              Gemini API (전용 키)            Gemini + 자체 fine-tune (vLLM)
localStorage                   Postgres RLS                   Postgres Sharded by region
                               Stripe                         Stripe + ChannelTalk
                               Sentry                         Datadog APM
                               —                              DICOM Gateway (orthanc)
                               —                              FHIR Server (HAPI)
                               —                              Mobile App (RN + EAS)
```

---

## 5. 가격 모델 상세

| 플랜 | 월 요금 | 환자 케이스 | AI 호출 | 기능 |
|---|---|---|---|---|
| **Free**     | $0    | 5/월   | 50회/월   | 4종 AI 진단, 3D 뷰어, 챗봇 (모델 1.5 Flash) |
| **Pro**      | $99   | 50/월  | 1,000회/월 | + Gemini Pro, 환자 대시보드, CSV/PDF 내보내기 |
| **Clinic**   | $499  | 무제한 | 10,000회/월 | + RLS 멀티유저(직원 10명), DICOM, 우선 지원 |
| **Enterprise** | 협의 | 무제한 | 무제한    | + 전용 모델 fine-tune, SLA 99.95%, 전담 매니저 |

**오버에이지**: AI 호출 한도 초과 시 호출당 $0.05.

**무료 트라이얼**: Pro 플랜 30일 무료, 카드 등록 불필요.

---

## 6. 데이터 마이그레이션 전략

### 6-1. MVP → Beta
**문제**: MVP는 localStorage 기반. SaaS는 서버 DB.
**해결**:
1. MVP에 "이전" 버튼 추가 → localStorage 데이터를 서버로 일괄 업로드
2. 환자 ID 충돌 시 클리닉별 prefix 자동 추가
3. 마이그레이션 후 localStorage는 캐시로만 사용

### 6-2. Beta → GA
**문제**: 단일 Postgres → 지역별 샤드 (한국/일본/북미/유럽)
**해결**:
1. `region` 컬럼 추가
2. Read replicas 우선 분산 → write 트래픽 30% 시점에 샤딩
3. Cross-region 분석 쿼리는 별도 OLAP (BigQuery)

### 6-3. 의료기기 인증 단계 데이터 보존
- 인증 신청 시점 모델 버전 동결 (`v1.0-FDA`)
- 모든 진단 결과는 모델 버전 포함 저장
- 인증 후 모델 변경 시 새 버전(`v1.1`) 등록

---

## 7. 보안·규정 진화

| 단계 | 표준 | 핵심 통제 |
|---|---|---|
| MVP | 일반 SaaS | TLS 1.3, 환경변수, basic auth |
| Beta | SOC 2 Type I | RLS, 감사 로그, MFA, encryption at rest |
| GA | HIPAA · ISO 27001 · MDR | BAA 체결, DLP, 의료기기 SOP, 임상 검증 |

---

## 8. 팀 진화

| 단계 | 인원 | 핵심 역할 |
|---|---|---|
| MVP | 3 | Founder 1, FE 1, AI 1 |
| Beta | 12 | + BE 2, Designer 1, Sales 2, CS 2, QA 1, RA(규제) 1 |
| GA | 60 | + 의료자문위 5, 임상연구원 8, ML 5, 보안 2, 글로벌 GTM 8 |

---

## 9. 리스크 & 완화

| 리스크 | 가능성 | 영향 | 완화책 |
|---|---|---|---|
| Gemini 가격 인상 | 중 | 높음 | 자체 모델 fine-tune 가속, 멀티 프로바이더 (Claude, GPT 추가) |
| 의료기기 인증 지연 | 높음 | 중 | RA 전문가 조기 영입, 임상 시험 사전 설계 |
| 빅테크 진입 (Google Health) | 중 | 매우 높음 | 한국·아시아 특화 데이터셋 구축, 의료법인 파트너십 lock-in |
| 의료사고 책임 | 낮음 | 매우 높음 | "임상 보조 도구" 명시, 사용 약관 + 보험 가입, 인증 단계 통과 |
| 데이터 유출 | 낮음 | 매우 높음 | HIPAA BAA, 분기별 펜테스트, 보안 인시던트 보험 |

---

## 10. 18개월 마일스톤

```
M0  : MVP 코드 완성, 5개 클리닉 PoC 시작
M3  : MVP 검증, 진단 200건. SaaS 설계 동결.
M6  : Beta 알파 (RLS + Stripe + Auth)
M9  : Beta GA (50 클리닉 유료 전환)
M12 : 의료기기 인증 신청 (식약처)
M15 : DICOM/FHIR 통합 + 모바일 앱
M18 : GA SaaS 출시. ARR $5M 목표. 미국 FDA 510(k) 신청.
```
