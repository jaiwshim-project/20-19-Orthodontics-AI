import { getAdmin } from '../lib/supabase.js';
import { azureVisionCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BUCKET = 'patient-photos';

export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

const VALID_CATEGORIES = ['intraoral', 'face', 'xray', 'model'];
const VALID_SLOTS = {
  intraoral: ['01_front', '02_left', '03_lower', '04_right', '05_upper'],
  face: ['01_45degree', '02_front', '03_lateral', '04_smile'],
  xray: ['01_ceph', '02_pano'],
  model: ['01_lower', '02_upper']
};

async function classifyImage(base64, mime, filename) {
  const prompt = `이 치과 교정 이미지를 분류하세요. 반드시 아래 JSON 형식으로만 응답하세요.

분류 기준:
- "intraoral": 구강 내부 사진 (치아, 잇몸, 교합면이 보이는 사진. 구강거울/리트랙터 사용)
- "face": 안면 사진 (얼굴이 보이는 사진, 파란 배경, 피부/귀/머리카락 보임)
- "xray": X-ray/방사선 사진 (세팔로, 파노라마 - 검은 배경에 뼈/치아가 하얗게 보임)
- "model": 3D 모델 렌더링 (해당 없으면 무시)

세부 분류:
- intraoral → slot: "01_front"(정면교합), "02_left"(좌측), "03_lower"(하악교합면), "04_right"(우측), "05_upper"(상악교합면)
- face → slot: "01_45degree"(45도사선), "02_front"(정면), "03_lateral"(측면), "04_smile"(스마일)
- xray → slot: "01_ceph"(측면세팔로), "02_pano"(파노라마)

응답 형식 (JSON만):
{"category":"intraoral","slot":"01_front","confidence":0.95}`;

  try {
    let response;
    if (isAzureChatConfigured()) {
      response = await azureVisionCompletion({
        system: '치과 교정 이미지 분류 AI. JSON으로만 응답.',
        images: [{ base64, contentType: mime }],
        prompt,
        temperature: 0.1,
        timeoutMs: 15000
      });
    } else if (GEMINI_API_KEY) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent([
        { inlineData: { data: base64, mimeType: mime } },
        { text: prompt }
      ]);
      response = result.response.text();
    } else {
      return classifyByFilename(filename);
    }

    const jsonMatch = response.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (VALID_CATEGORIES.includes(parsed.category) && VALID_SLOTS[parsed.category]?.includes(parsed.slot)) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[classify] AI 분류 실패, 파일명 폴백:', e.message);
  }

  return classifyByFilename(filename);
}

function classifyByFilename(filename) {
  const norm = filename.toLowerCase();
  if (/ceph|lateral.*xray|lat.*x/i.test(norm)) return { category: 'xray', slot: '01_ceph', confidence: 0.6 };
  if (/pano/i.test(norm)) return { category: 'xray', slot: '02_pano', confidence: 0.6 };
  if (/45|oblique|사선/i.test(norm)) return { category: 'face', slot: '01_45degree', confidence: 0.6 };
  if (/smile|스마일/i.test(norm)) return { category: 'face', slot: '04_smile', confidence: 0.6 };
  if (/front.*face|face.*front|안면.*정면/i.test(norm)) return { category: 'face', slot: '02_front', confidence: 0.6 };
  if (/lateral.*face|face.*lat|안면.*측면/i.test(norm)) return { category: 'face', slot: '03_lateral', confidence: 0.6 };
  if (/upper|상악|maxill/i.test(norm)) return { category: 'intraoral', slot: '05_upper', confidence: 0.5 };
  if (/lower|하악|mandib/i.test(norm)) return { category: 'intraoral', slot: '03_lower', confidence: 0.5 };
  if (/right|우측/i.test(norm)) return { category: 'intraoral', slot: '04_right', confidence: 0.5 };
  if (/left|좌측/i.test(norm)) return { category: 'intraoral', slot: '02_left', confidence: 0.5 };
  if (/front|정면/i.test(norm)) return { category: 'intraoral', slot: '01_front', confidence: 0.5 };
  return { category: 'intraoral', slot: '01_front', confidence: 0.3 };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { patientName, phase, images } = req.body || {};
    if (!patientName || !phase || !images || !Array.isArray(images)) {
      return res.status(400).json({ error: 'patientName, phase, images[] 필수' });
    }
    if (!['initial', 'final'].includes(phase)) {
      return res.status(400).json({ error: 'phase는 initial 또는 final' });
    }

    const sb = getAdmin();
    const results = [];
    const usedSlots = new Set();

    for (const img of images) {
      const { base64, filename, contentType, slotHint } = img;
      if (!base64 || !filename) continue;

      const mime = contentType || 'image/jpeg';
      let classification;

      if (slotHint && slotHint.category && slotHint.slot) {
        classification = slotHint;
      } else {
        classification = await classifyImage(base64, mime, filename);
      }

      // 슬롯 충돌 해결
      const slotKey = `${classification.category}/${classification.slot}`;
      if (usedSlots.has(slotKey)) {
        const slots = VALID_SLOTS[classification.category];
        const available = slots.find(s => !usedSlots.has(`${classification.category}/${s}`));
        if (available) classification.slot = available;
      }
      usedSlots.add(`${classification.category}/${classification.slot}`);

      // Supabase Storage에 업로드
      const phaseKr = phase === 'initial' ? '초진' : '최종';
      const ext = filename.split('.').pop().toLowerCase() || 'jpg';
      const storagePath = `${patientName}/${phaseKr}/${classification.category}/${classification.slot}.${ext}`;

      const buffer = Buffer.from(base64, 'base64');
      const { data, error } = await sb.storage.from(BUCKET).upload(storagePath, buffer, {
        contentType: mime,
        upsert: true
      });

      let publicUrl = null;
      if (!error && data) {
        const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(data.path);
        publicUrl = pub?.publicUrl || null;
      }

      results.push({
        filename,
        category: classification.category,
        slot: classification.slot,
        confidence: classification.confidence,
        storagePath,
        publicUrl,
        error: error?.message || null
      });
    }

    // patients 테이블의 metadata에 photo_urls 업데이트
    const photoUrls = {};
    for (const r of results) {
      if (!r.publicUrl) continue;
      if (!photoUrls[r.category]) photoUrls[r.category] = {};
      photoUrls[r.category][r.slot] = r.publicUrl;
    }

    const { data: existingPatients } = await sb
      .from('patients')
      .select('id, metadata')
      .eq('name', patientName)
      .limit(1);

    if (existingPatients?.length > 0) {
      const patient = existingPatients[0];
      const meta = patient.metadata || {};
      const phaseKey = phase === 'initial' ? 'initial_urls' : 'final_urls';
      meta[phaseKey] = { ...(meta[phaseKey] || {}), ...photoUrls };

      // 사진 수 업데이트
      const countKey = phase === 'initial' ? 'initial' : 'final';
      if (!meta[countKey]) meta[countKey] = {};
      for (const [cat, slots] of Object.entries(photoUrls)) {
        meta[countKey][cat] = Object.keys(slots).length;
      }

      await sb.from('patients').update({ metadata: meta }).eq('id', patient.id);
    }

    return res.status(200).json({ success: true, results, photoUrls });
  } catch (e) {
    console.error('[classify-and-upload]', e);
    return res.status(500).json({ error: e.message });
  }
}
