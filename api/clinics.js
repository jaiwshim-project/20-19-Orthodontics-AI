import { listClinics, upsertClinic } from '../lib/supabase.js';

let cache = null;
let cacheAt = 0;
const TTL = 60 * 60 * 1000;

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const now = Date.now();
      if (cache && now - cacheAt < TTL) {
        return res.status(200).json({ clinics: cache, cached: true });
      }
      try {
        const clinics = await listClinics();
        cache = clinics;
        cacheAt = now;
        return res.status(200).json({ clinics, cached: false });
      } catch (e) {
        console.warn('[clinics] DB 미연결, mock 반환:', e.message);
        const mock = [
          { id: 'mock-1', name: '강남 미소 치과', doctor: '김원장', region: '서울', tier: 'pro' },
          { id: 'mock-2', name: '연세 교정치과', doctor: '이원장', region: '경기', tier: 'free' },
          { id: 'mock-3', name: '부산 행복 교정', doctor: '박원장', region: '부산', tier: 'max' }
        ];
        return res.status(200).json({ clinics: mock, mock: true });
      }
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const clinic = {
        name: fixKoreanEncoding(body.name),
        doctor: fixKoreanEncoding(body.doctor),
        email: body.email,
        phone: body.phone,
        region: fixKoreanEncoding(body.region),
        tier: body.tier || 'free'
      };
      if (!clinic.name || !clinic.email) {
        return res.status(400).json({ error: '병원명과 이메일은 필수입니다.' });
      }
      const saved = await upsertClinic(clinic);
      cache = null;
      return res.status(200).json({ success: true, clinic: saved });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('[clinics] 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
