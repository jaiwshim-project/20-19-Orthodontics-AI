import { getAdmin } from '../lib/supabase.js';

const BUCKET = 'diagnosis-images';
const MAX_BYTES_PER = 20 * 1024 * 1024;

export const config = {
  api: { bodyParser: { sizeLimit: '60mb' } }
};

function safeFilename(slot, ext) {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${slot}.${ext}`;
}

function inferExt(mime) {
  return ({
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp'
  })[mime] || 'jpg';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { images, patientId, diagnosisType } = req.body || {};
  if (!images || typeof images !== 'object') {
    return res.status(400).json({ error: 'images 객체 필요' });
  }

  let sb;
  try {
    sb = getAdmin();
  } catch (e) {
    return res.status(200).json({ uploaded: [], fallback: true, message: 'Supabase 미설정' });
  }

  const uploaded = [];
  const errors = [];
  const folder = patientId
    ? `patients/${patientId}/${diagnosisType || 'misc'}`
    : `unassigned/${diagnosisType || 'misc'}`;

  for (const [slot, img] of Object.entries(images)) {
    try {
      if (!img?.base64) continue;
      const buffer = Buffer.from(img.base64, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_BYTES_PER) {
        errors.push({ slot, error: '크기 오류' });
        continue;
      }
      const mime = img.contentType || 'image/jpeg';
      const ext = inferExt(mime);
      const filename = safeFilename(slot, ext);
      const path = `${folder}/${filename}`;

      const { error: upErr } = await sb.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: mime, upsert: false });
      if (upErr) throw upErr;

      const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
      uploaded.push({
        slot,
        path,
        url: pub?.publicUrl || null,
        size: buffer.length,
        contentType: mime,
        uploadedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error(`[upload-images] ${slot} 실패:`, e.message);
      errors.push({ slot, error: e.message });
    }
  }

  return res.status(200).json({
    uploaded,
    errors,
    bucket: BUCKET,
    folder
  });
}
