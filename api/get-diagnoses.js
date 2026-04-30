import { getAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  // Vercel/dev 양쪽 호환: req.query 또는 URL parsing
  const url = new URL(req.url, 'http://localhost');
  const params = {
    id: req.query?.id || url.searchParams.get('id'),
    patient_id: req.query?.patient_id || url.searchParams.get('patient_id'),
    type: req.query?.type || url.searchParams.get('type'),
    limit: req.query?.limit || url.searchParams.get('limit')
  };
  const { id, patient_id, type, limit } = params;
  const lim = Math.min(parseInt(limit) || 100, 500);

  try {
    const sb = getAdmin();

    if (id) {
      const { data, error } = await sb
        .from('diagnoses')
        .select('*, patients(*)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return res.status(200).json({ source: 'supabase', record: data });
    }

    let q = sb
      .from('diagnoses')
      .select('id, type, created_at, result, inputs, patient_id, patients(id, name, age_group, gender, dob)')
      .order('created_at', { ascending: false })
      .limit(lim);

    if (patient_id) q = q.eq('patient_id', patient_id);
    if (type) q = q.eq('type', type);

    const { data, error } = await q;
    if (error) throw error;
    return res.status(200).json({ source: 'supabase', records: data || [] });
  } catch (e) {
    console.warn('[get-diagnoses] Supabase 실패, 클라이언트 localStorage 사용 안내:', e.message);
    return res.status(200).json({ source: 'local', fallback: true, records: [], message: 'Supabase 미설정 — 클라이언트 localStorage에서 로드하세요.' });
  }
}
