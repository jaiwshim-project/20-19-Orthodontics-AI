import { createClient } from '@supabase/supabase-js';
import { embed } from './embeddings.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase 환경 변수가 누락되었습니다. SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY를 설정하세요.');
  }
}

export function getAdmin() {
  assertEnv();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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
