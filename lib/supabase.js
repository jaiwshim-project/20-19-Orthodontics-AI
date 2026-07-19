import { createClient } from '@supabase/supabase-js';
import { embed } from './embeddings.js';

// Node.js 20(Vercel @vercel/node@3.2.0)에는 native WebSocket이 없어
// @supabase/supabase-js 2.108+ realtime-js가 로드 시 예외를 던진다.
// 서버 함수는 realtime을 쓰지 않지만 모듈 로드 자체가 막히므로 ws로 전역 폴리필.
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const { default: WS } = await import('ws');
    globalThis.WebSocket = WS;
  } catch (e) {
    console.warn('[supabase] ws 폴리필 로드 실패:', e.message);
  }
}

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

// 임베딩 없이 동작하는 키워드(텍스트) 검색 폴백.
// Gemini/Azure 임베딩이 불가할 때 김용을 원장 자료를 그래도 검색하기 위함.
export async function searchKnowledgeByKeyword(query, topK = 4) {
  try {
    const sb = getAdmin();
    // 한글/영문 토큰 추출 (2글자 이상), 상위 6개만 사용
    const tokens = (query.match(/[가-힣A-Za-z0-9]{2,}/g) || []).slice(0, 6);
    if (!tokens.length) return [];

    // 각 토큰을 content에 대해 ilike OR 검색
    const orExpr = tokens.map(t => `content.ilike.%${t}%`).join(',');
    const { data, error } = await sb
      .from('knowledge_chunks')
      .select('id, source, content, metadata')
      .or(orExpr)
      .limit(30);
    if (error) {
      console.error('[supabase] 키워드 검색 실패:', error.message);
      return [];
    }
    // 매칭 토큰 수로 랭킹 (김용을 자료 가산점)
    const scored = (data || []).map(row => {
      const c = (row.content || '').toLowerCase();
      let score = tokens.reduce((s, t) => s + (c.includes(t.toLowerCase()) ? 1 : 0), 0);
      if (row.metadata?.author === '김용을') score += 0.5;
      return { ...row, _score: score };
    });
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, topK);
  } catch (e) {
    console.error('[supabase] searchKnowledgeByKeyword 예외:', e.message);
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
