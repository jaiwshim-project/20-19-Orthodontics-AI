import { getAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const url = new URL(req.url, 'http://localhost');
  const id = req.query?.id || url.searchParams.get('id');
  const patientId = req.query?.patientId || req.query?.patient_id || url.searchParams.get('patientId') || url.searchParams.get('patient_id');
  const patientName = req.query?.patientName || req.query?.patient_name || url.searchParams.get('patientName') || url.searchParams.get('patient_name');
  const limitRaw = req.query?.limit || url.searchParams.get('limit');
  const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);

  try {
    const sb = getAdmin();

    if (id) {
      const { data, error } = await sb
        .from('equilibrium_analyses')
        .select('*, patients(id, name, age_group, gender, dob, metadata)')
        .eq('id', id)
        .single();
      if (error) throw error;
      return res.status(200).json({ source: 'supabase', record: data });
    }

    let query = sb
      .from('equilibrium_analyses')
      .select('id, patient_id, scale, upper_curves, lower_curves, ceph_analysis, plastic_model, discrepancy, decision, expert_label, assets_meta, notes, created_at, updated_at, patients(id, name, age_group, gender, dob, metadata)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (patientId) query = query.eq('patient_id', patientId);

    const { data, error } = await query;
    if (error) throw error;

    let records = data || [];
    if (patientName) {
      const needle = String(patientName).trim().toLowerCase();
      records = records.filter(record => String(record.patients?.name || '').toLowerCase().includes(needle));
    }

    return res.status(200).json({ source: 'supabase', records });
  } catch (e) {
    console.warn('[get-equilibrium-analyses] Supabase fallback:', e.message);
    return res.status(200).json({
      source: 'local',
      fallback: true,
      records: [],
      message: 'Supabase equilibrium_analyses 테이블이 아직 적용되지 않았습니다. Supabase SQL Editor에서 db/20260616_equilibrium_analyses.sql을 실행하세요.'
    });
  }
}

