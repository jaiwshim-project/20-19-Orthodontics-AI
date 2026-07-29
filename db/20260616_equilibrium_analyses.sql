-- EZ/TZ Equilibrium Zone Analysis
-- Apply after db/schema.sql in Supabase SQL Editor.

create table if not exists equilibrium_analyses (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  scale jsonb default '{}'::jsonb,
  upper_curves jsonb default '{}'::jsonb,
  lower_curves jsonb default '{}'::jsonb,
  ceph_analysis jsonb default '{}'::jsonb,
  plastic_model jsonb default '{}'::jsonb,
  discrepancy jsonb default '{}'::jsonb,
  decision jsonb default '{}'::jsonb,
  expert_label jsonb default '{}'::jsonb,
  assets_meta jsonb default '{}'::jsonb,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_equilibrium_patient
  on equilibrium_analyses(patient_id);

create index if not exists idx_equilibrium_created_at
  on equilibrium_analyses(created_at desc);

create index if not exists idx_equilibrium_decision_classification
  on equilibrium_analyses((decision->>'classification'));

alter table equilibrium_analyses enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'equilibrium_analyses'
      and policyname = 'users see own equilibrium analyses'
  ) then
    create policy "users see own equilibrium analyses" on equilibrium_analyses
      for all using (
        patient_id in (
          select id from patients
          where clinic_id = (
            select clinic_id from users where users.id = auth.uid()
          )
        )
      );
  end if;
end $$;
