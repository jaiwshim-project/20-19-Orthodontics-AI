import { getAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  // search 쿼리 파라미터
  const url = new URL(req.url, 'http://localhost');
  const q = (req.query?.q || url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(req.query?.limit || url.searchParams.get('limit') || '200'), 500);

  try {
    const sb = getAdmin();
    let query = sb
      .from('patients')
      .select('id, name, dob, age_group, gender, metadata, created_at, diagnoses(id, type, created_at, result)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (q) {
      query = query.ilike('name', `%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    // 환자별 진단 통계 계산
    const enriched = (data || []).map(p => {
      const diagnoses = p.diagnoses || [];
      const lastAt = diagnoses.length
        ? diagnoses.map(d => d.created_at).sort().reverse()[0]
        : null;
      const types = [...new Set(diagnoses.map(d => d.type))];
      const lastRecurrence = diagnoses
        .filter(d => d.type === 'recurrence')
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0]
        ?.result?.probabilities?.y10;
      return {
        id: p.id,
        name: p.name,
        dob: p.dob,
        age_group: p.age_group,
        gender: p.gender,
        age: p.metadata?.age || null,
        created_at: p.created_at,
        diagnosis_count: diagnoses.length,
        diagnosis_types: types,
        last_diagnosis_at: lastAt,
        last_recurrence_y10: lastRecurrence ?? null
      };
    });

    return res.status(200).json({ source: 'supabase', records: enriched });
  } catch (e) {
    console.warn('[get-patients] Supabase 실패:', e.message);
    return res.status(200).json({ source: 'local', fallback: true, records: [], message: e.message });
  }
}
