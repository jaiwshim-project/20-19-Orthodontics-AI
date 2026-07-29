-- Training Data Tables for EZL/TTL labels and Class I learning
-- Apply after db/schema.sql and db/20260616_equilibrium_analyses.sql

-- ========================================
-- EZL/TTL 곡선 라벨 데이터 (의사가 찍은 Ground Truth)
-- ========================================
create table if not exists ezl_ttl_labels (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete set null,
  patient_name text,
  arch text not null check (arch in ('upper', 'lower')),
  phase text not null check (phase in ('initial', 'final')),
  classification text check (classification in ('class1', 'class2', 'class3')),

  -- EZL (노란색 곡선) 포인트 좌표 [{x, y}, ...]
  ezl_points jsonb not null default '[]'::jsonb,
  -- TTL (빨간색/검은색 곡선) 포인트 좌표 [{x, y}, ...]
  ttl_points jsonb not null default '[]'::jsonb,

  -- 계산 결과
  ezl_length_px numeric,
  ttl_length_px numeric,
  ezl_length_mm numeric,
  ttl_length_mm numeric,
  discrepancy_mm numeric,  -- TTL - EZL
  px_per_mm numeric,

  -- 이미지 참조
  image_url text,
  image_width int,
  image_height int,

  -- 메타
  labeled_by text,  -- 라벨링한 사람 (의사명)
  confidence numeric default 1.0,
  notes text,
  created_at timestamptz default now()
);

create index if not exists idx_ezl_ttl_arch on ezl_ttl_labels(arch);
create index if not exists idx_ezl_ttl_phase on ezl_ttl_labels(phase);
create index if not exists idx_ezl_ttl_class on ezl_ttl_labels(classification);

-- ========================================
-- 학습 케이스 메타데이터
-- ========================================
create table if not exists training_cases (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete set null,
  case_code text not null,  -- 예: "3278 신진용"
  classification text check (classification in ('class1', 'class2', 'class3')),
  phase text not null check (phase in ('initial', 'final')),

  -- 보유 자료
  has_intraoral boolean default false,
  has_ceph boolean default false,
  has_face boolean default false,
  has_model boolean default false,

  -- 진단 정보
  diagnosis jsonb default '{}'::jsonb,
  treatment_group text check (treatment_group in ('A', 'B', 'C', 'D', 'E')),

  -- 세팔로 계측값
  ceph_values jsonb default '{}'::jsonb,

  -- 파일 경로 목록
  files jsonb default '[]'::jsonb,

  created_at timestamptz default now()
);

create index if not exists idx_training_class on training_cases(classification);
create index if not exists idx_training_case_code on training_cases(case_code);
