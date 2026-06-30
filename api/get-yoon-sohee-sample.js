import { getAdmin } from '../lib/supabase.js';
import sharp from 'sharp';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};

const SLOT_LABELS = {
  frontal: '구강 정면',
  rightLateral: '구강 우측면',
  leftLateral: '구강 좌측면',
  upperOcclusal: '상악 교합면',
  lowerOcclusal: '하악 교합면',
  ceph: '세팔로 측면',
  cephPA: '파노라마/정면 방사선',
  faceFront: '안면 정면',
  faceLateral: '안면 측면',
  faceSmile: '스마일',
  face45: '45도 안면'
};

async function blobToBuffer(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

async function imageToDataUrl(buffer) {
  const converted = await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${converted.toString('base64')}`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const sb = getAdmin();
    const url = new URL(req.url, 'http://localhost');
    const name = url.searchParams.get('name') || req.query?.name || '윤소희';
    const phase = url.searchParams.get('phase') || req.query?.phase || 'initial';

    const { data: patients, error: pErr } = await sb
      .from('patients')
      .select('id, name, age_group, gender, dob, metadata, created_at')
      .ilike('name', `%${name}%`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (pErr) throw pErr;
    const patient = patients?.[0];
    if (!patient) return res.status(404).json({ error: `${name} 환자 데이터를 찾지 못했습니다.` });

    const { data: cases, error: cErr } = await sb
      .from('training_cases')
      .select('*')
      .eq('patient_id', patient.id)
      .eq('phase', phase)
      .order('created_at', { ascending: false })
      .limit(1);
    if (cErr) throw cErr;
    const trainingCase = cases?.[0];
    if (!trainingCase?.files) return res.status(404).json({ error: `${patient.name} ${phase} 이미지 DB 기록이 없습니다.` });

    const photos = {};
    const errors = [];
    for (const [slot, meta] of Object.entries(trainingCase.files)) {
      if (!meta?.path || !meta?.bucket) continue;
      if (!SLOT_LABELS[slot]) continue;
      try {
        const { data: blob, error } = await sb.storage.from(meta.bucket).download(meta.path);
        if (error) throw error;
        const buffer = await blobToBuffer(blob);
        photos[slot] = {
          base64: await imageToDataUrl(buffer),
          name: meta.name || `${slot}.jpg`,
          type: 'image/jpeg',
          source: 'supabase',
          bucket: meta.bucket,
          path: meta.path,
          label: SLOT_LABELS[slot]
        };
      } catch (e) {
        errors.push({ slot, path: meta.path, error: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      source: 'supabase',
      patient: {
        id: patient.id,
        supabaseId: patient.id,
        name: patient.name,
        ageGroup: patient.age_group,
        gender: patient.gender,
        dob: patient.dob,
        chartNumber: patient.metadata?.chartNumber || null,
        dentitionStage: patient.metadata?.stage || 'permanent_dentition',
        classification: patient.metadata?.classification || trainingCase.classification || null,
        metadata: patient.metadata || {}
      },
      trainingCase: {
        id: trainingCase.id,
        caseCode: trainingCase.case_code,
        phase: trainingCase.phase,
        classification: trainingCase.classification
      },
      photos,
      errors
    });
  } catch (e) {
    console.error('[get-yoon-sohee-sample] failed:', e);
    return res.status(500).json({ error: e.message });
  }
}
