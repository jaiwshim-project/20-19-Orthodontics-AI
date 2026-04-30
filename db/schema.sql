-- 20-19 Orthodontics AI — Supabase Postgres 초기 스키마
-- pgvector 확장 활성화 후 실행

create extension if not exists "vector";
create extension if not exists "pgcrypto";

-- ========================================
-- 1. clinics — 병원 (테넌트)
-- ========================================
create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  doctor text,
  email text unique not null,
  phone text,
  region text,
  tier text default 'free' check (tier in ('free', 'pro', 'max', 'enterprise')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_clinics_email on clinics(email);

-- ========================================
-- 2. users — 사용자 (병원 직원)
-- ========================================
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  email text unique not null,
  name text,
  role text default 'staff' check (role in ('owner', 'doctor', 'staff', 'admin')),
  password_hash text,
  is_admin boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_users_clinic on users(clinic_id);

-- ========================================
-- 3. patients — 환자
-- ========================================
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  name text not null,
  dob date,
  age_group text check (age_group in ('child', 'adult')),
  gender text check (gender in ('male', 'female', 'other')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_patients_clinic on patients(clinic_id);
create index if not exists idx_patients_age_group on patients(age_group);

-- ========================================
-- 4. diagnoses — AI 진단 결과
-- ========================================
create table if not exists diagnoses (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  type text not null check (type in ('extraction', 'growth', 'facial', 'recurrence')),
  inputs jsonb not null,
  result jsonb not null,
  created_at timestamptz default now()
);
create index if not exists idx_diagnoses_patient on diagnoses(patient_id);
create index if not exists idx_diagnoses_type on diagnoses(type);

-- ========================================
-- 5. conversations — RAG 챗 대화 로그
-- ========================================
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  messages jsonb not null,
  created_at timestamptz default now()
);
create index if not exists idx_conversations_user on conversations(user_id);

-- ========================================
-- 6. knowledge_chunks — RAG 지식베이스
-- ========================================
create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source text,
  content text not null,
  embedding vector(768),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists idx_knowledge_embedding
  on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- RAG 검색 함수
create or replace function match_knowledge_chunks(
  query_embedding vector(768),
  match_count int default 3,
  similarity_threshold float default 0.5
) returns table (
  id uuid,
  content text,
  source text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    kc.id,
    kc.content,
    kc.source,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  where 1 - (kc.embedding <=> query_embedding) > similarity_threshold
  order by kc.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ========================================
-- 7. RLS — 행 수준 보안 (clinic_id 기반 멀티테넌시)
-- ========================================
alter table clinics enable row level security;
alter table users enable row level security;
alter table patients enable row level security;
alter table diagnoses enable row level security;
alter table conversations enable row level security;

-- 자기 병원만 조회 가능
create policy "users see own clinic" on clinics
  for select using (id = (select clinic_id from users where users.id = auth.uid()));

create policy "users see own clinic users" on users
  for select using (clinic_id = (select clinic_id from users where users.id = auth.uid()));

create policy "users see own clinic patients" on patients
  for all using (clinic_id = (select clinic_id from users where users.id = auth.uid()));

create policy "users see own diagnoses" on diagnoses
  for all using (patient_id in (
    select id from patients where clinic_id = (select clinic_id from users where users.id = auth.uid())
  ));

create policy "users see own conversations" on conversations
  for all using (user_id = auth.uid());

-- 지식베이스는 모두 읽기 허용
alter table knowledge_chunks enable row level security;
create policy "knowledge readable by all" on knowledge_chunks
  for select using (true);

-- ========================================
-- 8. Storage 버킷 (Supabase Dashboard에서 별도 생성)
-- ========================================
-- bucket: uploads (private), public read for /public/* paths
