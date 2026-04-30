import { getAdmin } from '../lib/supabase.js';

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

function deepFix(obj) {
  if (Array.isArray(obj)) return obj.map(deepFix);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepFix(v);
    return out;
  }
  if (typeof obj === 'string') return fixKoreanEncoding(obj);
  return obj;
}

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = deepFix(req.body || {});
    const { patient = {}, type, inputs = {}, result = {}, imagesMeta = [], notes = '' } = body;

    if (!type) return res.status(400).json({ error: 'type 필요' });
    if (!patient.name) return res.status(400).json({ error: '환자 이름 필요' });

    let supabaseAvailable = false;
    let saved = null;

    // Try Supabase first
    try {
      const sb = getAdmin();
      // 1) 환자 조회 — supabaseId 있으면 기존 사용, 없으면 name+dob로 조회 후 INSERT
      let patRow = null;
      const existingId = patient.supabaseId || patient.id;
      if (existingId && /^[0-9a-f-]{36}$/i.test(existingId)) {
        const { data: byId } = await sb.from('patients').select('*').eq('id', existingId).maybeSingle();
        if (byId) patRow = byId;
      }
      if (!patRow && patient.name) {
        const dob = patient.dob || null;
        let q = sb.from('patients').select('*').eq('name', patient.name);
        if (dob) q = q.eq('dob', dob); else q = q.is('dob', null);
        const { data: byNameDob } = await q.limit(1);
        if (byNameDob?.[0]) patRow = byNameDob[0];
      }
      if (!patRow) {
        const patientPayload = {
          name: patient.name,
          dob: patient.dob || null,
          age_group: patient.ageGroup || null,
          gender: patient.gender || null,
          metadata: { age: patient.age || null }
        };
        const { data, error } = await sb.from('patients').insert(patientPayload).select().single();
        if (error) throw error;
        patRow = data;
      }

      // 2) 진단 저장
      const diagPayload = {
        patient_id: patRow.id,
        type,
        inputs,
        result: { ...result, imagesMeta, notes, status: 'pending_review' }
      };
      const { data: diagRow, error: diagErr } = await sb
        .from('diagnoses')
        .insert(diagPayload)
        .select()
        .single();
      if (diagErr) throw diagErr;

      saved = { id: diagRow.id, patient: patRow, diagnosis: diagRow, source: 'supabase' };
      supabaseAvailable = true;
    } catch (e) {
      console.warn('[save-diagnosis] Supabase 미사용, 로컬 폴백 안내:', e.message);
    }

    if (supabaseAvailable && saved) {
      return res.status(200).json({ success: true, source: 'supabase', ...saved });
    }

    // Supabase 없으면 클라이언트에 폴백 안내
    return res.status(200).json({
      success: true,
      source: 'local',
      fallback: true,
      message: 'Supabase 미설정 — 클라이언트 localStorage에 저장하세요.',
      record: {
        id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        patient,
        type,
        inputs,
        result: { ...result, imagesMeta, notes, status: 'pending_review' },
        created_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error('[save-diagnosis] 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
