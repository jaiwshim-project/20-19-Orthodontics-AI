import { getAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method Not Allowed' });

  const { id, status, doctor_note } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id 필요' });

  const allowedStatus = ['pending_review', 'reviewed', 'accepted', 'rejected', 'archived'];
  if (status && !allowedStatus.includes(status)) {
    return res.status(400).json({ error: `허용 status: ${allowedStatus.join(', ')}` });
  }

  try {
    const sb = getAdmin();
    // 기존 result fetch → status/note 병합
    const { data: existing, error: fetchErr } = await sb
      .from('diagnoses').select('result').eq('id', id).single();
    if (fetchErr) throw fetchErr;

    const newResult = {
      ...(existing?.result || {}),
      ...(status ? { status, status_changed_at: new Date().toISOString() } : {}),
      ...(doctor_note !== undefined ? { doctor_note } : {})
    };

    const { data, error } = await sb
      .from('diagnoses')
      .update({ result: newResult })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    return res.status(200).json({ success: true, record: data });
  } catch (e) {
    console.warn('[update-diagnosis] Supabase 실패:', e.message);
    return res.status(200).json({ success: false, fallback: true, message: '클라이언트 localStorage에서 직접 갱신하세요.' });
  }
}
