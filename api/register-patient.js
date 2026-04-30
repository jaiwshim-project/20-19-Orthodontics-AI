import { getAdmin } from '../lib/supabase.js';

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};
  const name = fixKoreanEncoding((body.name || '').trim());
  if (!name) return res.status(400).json({ error: '이름 필수' });

  const dob = body.dob || null;
  const ageGroup = body.ageGroup || null;
  const gender = body.gender || null;
  const age = body.age || null;

  try {
    const sb = getAdmin();

    // 동일 환자 (name + dob) 존재 확인 — 중복 방지
    let existing = null;
    if (dob) {
      const { data } = await sb
        .from('patients')
        .select('*')
        .eq('name', name)
        .eq('dob', dob)
        .limit(1);
      existing = data?.[0];
    } else {
      const { data } = await sb
        .from('patients')
        .select('*')
        .eq('name', name)
        .is('dob', null)
        .limit(1);
      existing = data?.[0];
    }

    if (existing) {
      return res.status(200).json({ success: true, source: 'supabase', patient: existing, duplicate: true });
    }

    const { data, error } = await sb
      .from('patients')
      .insert({
        name, dob, age_group: ageGroup, gender,
        metadata: { age }
      })
      .select()
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, source: 'supabase', patient: data });
  } catch (e) {
    console.warn('[register-patient] Supabase 실패:', e.message);
    return res.status(200).json({ success: true, source: 'local', fallback: true, message: e.message });
  }
}
