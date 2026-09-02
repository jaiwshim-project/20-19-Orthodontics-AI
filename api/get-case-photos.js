import { getAdmin } from '../lib/supabase.js';
import { safeErrorMessage } from '../lib/safe-error.js';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } }
};

const PHASE_KEY = {
  initial: 'initial_urls',
  final: 'final_urls'
};

const SLOT_TO_CLIENT_KEY = {
  'intraoral/01_front': 'frontal',
  'intraoral/02_left': 'leftLateral',
  'intraoral/03_lower': 'lowerOcclusal',
  'intraoral/04_right': 'rightLateral',
  'intraoral/05_upper': 'upperOcclusal',
  'face/01_45degree': 'face45',
  'face/02_front': 'faceFront',
  'face/03_lateral': 'faceLateral',
  'face/04_smile': 'faceSmile',
  'xray/01_ceph': 'ceph',
  'xray/02_pano': 'cephPA',
  'model/01_lower': 'modelLower',
  'model/02_upper': 'modelUpper'
};

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('.').pop()?.toLowerCase() || 'jpg';
  } catch {
    return 'jpg';
  }
}

function mimeFromExtension(ext) {
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'stl') return 'model/stl';
  if (ext === 'ply') return 'application/octet-stream';
  return 'image/jpeg';
}

async function urlToEntry(url, fallbackName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || mimeFromExtension(extensionFromUrl(url));
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    base64: `data:${contentType};base64,${buffer.toString('base64')}`,
    name: fallbackName,
    type: contentType,
    source: 'supabase',
    url
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const url = new URL(req.url, 'http://localhost');
    const id = req.query?.id || url.searchParams.get('id');
    const name = (req.query?.name || url.searchParams.get('name') || '').trim();
    const phase = req.query?.phase || url.searchParams.get('phase') || 'initial';
    const phaseKey = PHASE_KEY[phase] || PHASE_KEY.initial;

    if (!id && !name) return res.status(400).json({ error: 'id or name is required' });

    const sb = getAdmin();
    let query = sb
      .from('patients')
      .select('id, name, age_group, gender, dob, metadata, created_at')
      .limit(1);

    query = id ? query.eq('id', id) : query.eq('name', name);

    const { data: patients, error } = await query;
    if (error) throw error;

    const patient = patients?.[0];
    if (!patient) return res.status(404).json({ error: 'patient not found' });

    const metadata = patient.metadata || {};
    const urls = metadata[phaseKey] || {};
    const photos = {};
    const errors = [];

    for (const [category, slots] of Object.entries(urls)) {
      for (const [slot, publicUrl] of Object.entries(slots || {})) {
        const clientKey = SLOT_TO_CLIENT_KEY[`${category}/${slot}`];
        if (!clientKey || !publicUrl) continue;
        try {
          const ext = extensionFromUrl(publicUrl);
          photos[clientKey] = await urlToEntry(publicUrl, `${clientKey}.${ext}`);
        } catch (e) {
          errors.push({ category, slot, key: clientKey, error: safeErrorMessage(e) });
        }
      }
    }

    return res.status(200).json({
      success: true,
      source: 'supabase',
      phase,
      patient: {
        id: patient.id,
        supabaseId: patient.id,
        name: patient.name,
        dob: patient.dob,
        ageGroup: patient.age_group,
        gender: patient.gender,
        stage: metadata.stage || metadata.dentitionStage || 'permanent_dentition',
        dentitionStage: metadata.stage || metadata.dentitionStage || 'permanent_dentition',
        classification: metadata.classification || null,
        metadata
      },
      photos,
      errors
    });
  } catch (e) {
    console.error('[get-case-photos]', e);
    return res.status(500).json({ error: safeErrorMessage(e) });
  }
}
