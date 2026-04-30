import { createClient } from '@supabase/supabase-js';
import { embed } from './embeddings.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertEnv() {
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL이 설정되지 않았습니다.');
  }
  if (!SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE_ANON_KEY 중 하나는 필요합니다.');
  }
}

export function getAdmin() {
  assertEnv();
  // service_role 우선, 없으면 anon으로 폴백 (RLS 정책 영향 받음)
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[supabase] SERVICE_ROLE_KEY 부재 → ANON 폴백 (RLS 정책 영향). INSERT/UPDATE는 정책에 따라 차단될 수 있습니다.');
  }
  return createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export function getClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase 클라이언트 환경 변수 누락 (SUPABASE_URL, SUPABASE_ANON_KEY)');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export async function searchKnowledge(query, topK = 3) {
  try {
    const sb = getAdmin();
    const vec = await embed(query);
    const { data, error } = await sb.rpc('match_knowledge_chunks', {
      query_embedding: vec,
      match_count: topK,
      similarity_threshold: 0.5
    });
    if (error) {
      console.error('[supabase] RAG 검색 실패:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[supabase] searchKnowledge 예외:', e.message);
    return [];
  }
}

export async function saveConversation(userId, messages) {
  const sb = getAdmin();
  const { data, error } = await sb
    .from('conversations')
    .insert({ user_id: userId, messages })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listClinics() {
  const sb = getAdmin();
  const { data, error } = await sb
    .from('clinics')
    .select('id, name, doctor, region, tier, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function upsertClinic(clinic) {
  const sb = getAdmin();
  const { data, error } = await sb
    .from('clinics')
    .upsert(clinic, { onConflict: 'email' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function saveDiagnosis({ patientId, type, inputs, result }) {
  const sb = getAdmin();
  const { data, error } = await sb
    .from('diagnoses')
    .insert({ patient_id: patientId, type, inputs, result })
    .select()
    .single();
  if (error) throw error;
  return data;
}
