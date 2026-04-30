# 20-19 Orthodontics AI

> 교정치과 AI 플랫폼 — 발치 판단, 성장 예측, 안모 시뮬레이션, 재발 예측 4대 AI 엔진과 EZL-STL 3D 뷰어, RAG 챗봇을 통합한 차세대 의사결정 보조 도구.

[![MVP](https://img.shields.io/badge/Status-MVP%20v0.1-0EA5E9)]() [![Stack](https://img.shields.io/badge/Stack-HTML%20%2B%20Vercel%20%2B%20Gemini-8B5CF6)]() [![License](https://img.shields.io/badge/License-Proprietary-EF4444)]()

---

## 빠른 시작

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경변수 설정
```bash
cp .env.example .env.local
# .env.local 편집해 GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 입력
```

### 3. 로컬 개발 서버
```bash
npm run dev
# http://localhost:3000 접속
```

### 4. Vercel 배포
```bash
npm run deploy
# 또는 git push (Vercel 연동 시 자동 배포)
```

### 5. Supabase 스키마 적용
Supabase Dashboard → SQL Editor에서 `db/schema.sql` 실행.

---

## 핵심 기능

| 페이지 | 설명 |
|---|---|
| `index.html` | 랜딩 + 8개 기능 허브 |
| `3d-viewer.html` | Three.js + STL 뷰어, EZL-STL 자동 측정 |
| `extraction-ai.html` | 발치 판단 AI (성인/어린이 분기) |
| `growth-prediction.html` | 어린이 성장 예측 (CVMS 기반) |
| `facial-simulation.html` | 측면 안모 SVG 실시간 시뮬레이션 |
| `recurrence-prediction.html` | 1·3·5·10년 재발 확률 |
| `chatbot.html` | Gemini + Supabase pgvector RAG |
| `dashboard.html` | 환자/진단 분석 대시보드 |
| `manual.html` | 사용자 매뉴얼 + FAQ |
| `architecture.html` | 시스템 아키텍처 (4계층 SVG) |

---

## 기술 스택

- **Frontend**: 정적 HTML + Vanilla JS + Three.js (CDN) + Chart.js (CDN)
- **Backend**: Vercel Serverless Functions (Node 20)
- **AI**: Google Gemini 1.5/2.0 Flash, Pro, Vision, text-embedding-004
- **DB**: Supabase Postgres + pgvector + Storage
- **지식그래프**: Neo4j (선택, SaaS 단계)
- **배포**: Vercel + Cron

---

## 디렉토리 구조

```
20-19 Orthodontics AI/
├── api/                    # Vercel Serverless Functions
│   ├── chat.js             # RAG + Gemini 챗
│   ├── diagnose.js         # 4종 AI 진단 통합
│   ├── upload.js           # 파일 업로드 + Vision
│   └── clinics.js          # 병원 등록 (1h 캐시)
├── lib/
│   ├── supabase.js         # Supabase 헬퍼 (admin/client)
│   └── embeddings.js       # Gemini 임베딩
├── js/
│   ├── common.js           # 사이드바·토스트·환자 스토어
│   ├── ezl-stl-engine.js   # 교정 측정 알고리즘
│   └── charts.js           # Chart.js 래퍼
├── css/
│   ├── global.css          # 디자인 시스템
│   └── 3d-viewer.css       # 뷰어 전용
├── docs/
│   ├── PRD.md              # 제품 요구사항
│   ├── AI_AGENTS_20.md     # 20개 AI 에이전트 명세
│   ├── MVP_TO_SAAS.md      # SaaS 전환 로드맵
│   ├── STRATEGY_1T.md      # 1조 기업 전략
│   └── NEO4J_SCHEMA.cypher # 지식그래프 스키마
├── db/
│   └── schema.sql          # Supabase 초기 스키마
├── assets/
│   └── architecture-overview.svg
├── *.html                  # 사용자용 페이지 8종
├── package.json
├── vercel.json
└── .env.example
```

---

## 환경 변수

| 키 | 필수 | 설명 |
|---|---|---|
| `GEMINI_API_KEY` | ★ | Google AI Studio에서 발급 |
| `SUPABASE_URL` | ★ | https://xxx.supabase.co |
| `SUPABASE_ANON_KEY` | ★ | 클라이언트용 |
| `SUPABASE_SERVICE_ROLE_KEY` | ★ | 서버용 (절대 노출 금지) |
| `ADMIN_DASH_PASS` | 선택 | 관리자 대시보드 비밀번호 |
| `NEO4J_URI` 등 | 선택 | SaaS 단계 |

---

## 배포

### Vercel
1. GitHub에 푸시
2. Vercel에서 import
3. Environment Variables 4종 입력
4. Deploy

### Supabase
1. 프로젝트 생성
2. SQL Editor에서 `db/schema.sql` 실행
3. Storage → `uploads` 버킷 생성 (private)
4. URL/Keys를 Vercel 환경변수로 복사

---

## 라이선스

Proprietary — Unauthorized copying, distribution, or commercial use is prohibited.

---

## 문서

- [PRD (제품 요구사항)](docs/PRD.md)
- [AI 에이전트 20개 명세](docs/AI_AGENTS_20.md)
- [MVP → SaaS 로드맵](docs/MVP_TO_SAAS.md)
- [1조 기업 전략](docs/STRATEGY_1T.md)
- [Neo4j 스키마](docs/NEO4J_SCHEMA.cypher)
- [매뉴얼 (HTML)](manual.html)
- [아키텍처 (HTML)](architecture.html)

---

## 면책

본 시스템은 임상 의사결정 보조 도구입니다. 모든 최종 진단과 치료 결정은 자격을 갖춘 전문의의 판단에 따르며, 본 시스템의 출력만을 근거로 환자에게 의료 행위를 수행해서는 안 됩니다.
