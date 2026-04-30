import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const KO_RULE = `
중요: notes는 반드시 한국어로 작성하세요. 의학 용어는 영문 병기 가능 (예: "치근 흡수(root resorption)").`;

const DUAL_IMAGE_RULE = `
입력 이미지는 최대 5장이며, 각 이미지 직전에 라벨 텍스트가 붙어있습니다:
- "[3D 스캐너 / 구강 모형]"   → 치아 배열·Crowding·Overjet·Overbite 측정
- "[X-ray / 두부방사선]"      → ANB·FMA·IMPA·골격 관계·CVMS 측정
- "[정면 안모]"                → 안면 대칭·하안면부 비율·미소선 평가
- "[측면 안모 / Profile]"     → E-line·입술 돌출·턱 위치·Profile(straight/convex/concave)
- "[입술 벌린 정면 / Intraoral]" → 미소시 치아 노출·치은 노출·중심선
제공된 이미지 종류에 따라 가능한 항목만 추출하고, 관찰 불가 항목은 null로 반환하세요.`;

const SCHEMAS = {
  extraction: {
    instruction: `당신은 교정치과 영상 분석 AI입니다.
입력된 이미지(들)를 분석해 다음 측정값을 JSON으로 반환하세요.
스키마:
{
  "fields": {
    "anb": number | null,
    "crowding": number | null,
    "overjet": number | null,
    "overbite": number | null,
    "profile": "straight"|"convex"|"concave" | null,
    "lipStrain": "none"|"mild"|"severe" | null,
    "fma": number | null,
    "impa": number | null
  },
  "confidence": number,
  "notes": string
}${DUAL_IMAGE_RULE}${KO_RULE}`
  },
  growth: {
    instruction: `당신은 골성숙 단계 분석 AI입니다.
손목 X-ray와 측면 두부방사선 중 1장 또는 2장으로 골연령(boneAge)과 CVMS 단계(cvms 1-6)를 추정하세요.
스키마:
{
  "fields": {
    "boneAge": number | null,
    "cvms": 1|2|3|4|5|6 | null,
    "height": null,
    "weight": null
  },
  "confidence": number,
  "notes": string
}
신장·체중은 사진에서 추출 불가능 — 항상 null.
손목 X-ray가 있으면 MP3·sesamoid·distal phalanx 관찰. Ceph가 있으면 C2-C4로 CVMS 판정.${KO_RULE}`
  },
  facial: {
    instruction: `당신은 안모 분석 AI입니다.
환자 측면 사진과 (선택적으로) 두부방사선을 분석해 권장 변화량(mm)을 제시.
양수=후방/내측, 음수=전방/외측, 0=변화 불필요.
스키마:
{
  "fields": {
    "maxRetract": number,
    "mandShift": number,
    "lipUpper": number,
    "lipLower": number,
    "chin": number
  },
  "confidence": number,
  "notes": string
}
관찰: 입술 돌출, 턱 후퇴, E-line 관계, 연조직 두께(있을 시 ceph).${KO_RULE}`
  },
  recurrence: {
    instruction: `당신은 치료 종료 시점의 교정 결과 분석 AI입니다.
모형 사진/STL과 두부방사선 중 1장 또는 2장으로 다음을 추정.
스키마:
{
  "fields": {
    "impa": number | null,
    "incisorShift": number | null,
    "residual": number | null
  },
  "confidence": number,
  "notes": string
}${KO_RULE}`
  }
};

function fallbackFields(type) {
  const base = { confidence: 0.4, fallback: true, note: 'AI 호출 실패 또는 키 미설정 — 데모 추정값을 표시합니다. 반드시 직접 측정값을 검증하세요.' };
  if (type === 'extraction') return { ...base, fields: { anb: 4.0, crowding: 5.5, overjet: 4.0, overbite: 3.0, profile: 'convex', lipStrain: 'mild', fma: 25, impa: 92 } };
  if (type === 'growth')     return { ...base, fields: { boneAge: 11.5, cvms: 2, height: null, weight: null } };
  if (type === 'facial')     return { ...base, fields: { maxRetract: 1.5, mandShift: 0, lipUpper: -1, lipLower: -0.5, chin: 0 } };
  if (type === 'recurrence') return { ...base, fields: { impa: 92, incisorShift: 1.5, residual: 0.5 } };
  return { ...base, fields: {} };
}

function clampNumber(v, lo, hi) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

function sanitizeFields(type, fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  if (type === 'extraction') {
    out.anb = clampNumber(fields.anb, -10, 15);
    out.crowding = clampNumber(fields.crowding, 0, 20);
    out.overjet = clampNumber(fields.overjet, -10, 20);
    out.overbite = clampNumber(fields.overbite, -10, 15);
    out.profile = ['straight', 'convex', 'concave'].includes(fields.profile) ? fields.profile : null;
    out.lipStrain = ['none', 'mild', 'severe'].includes(fields.lipStrain) ? fields.lipStrain : null;
    out.fma = clampNumber(fields.fma, 10, 50);
    out.impa = clampNumber(fields.impa, 70, 110);
  } else if (type === 'growth') {
    out.boneAge = clampNumber(fields.boneAge, 5, 20);
    const cv = parseInt(fields.cvms);
    out.cvms = (cv >= 1 && cv <= 6) ? cv : null;
    out.height = null;
    out.weight = null;
  } else if (type === 'facial') {
    out.maxRetract = clampNumber(fields.maxRetract, -2, 6) ?? 0;
    out.mandShift = clampNumber(fields.mandShift, -5, 5) ?? 0;
    out.lipUpper = clampNumber(fields.lipUpper, -3, 3) ?? 0;
    out.lipLower = clampNumber(fields.lipLower, -3, 3) ?? 0;
    out.chin = clampNumber(fields.chin, -3, 3) ?? 0;
  } else if (type === 'recurrence') {
    out.impa = clampNumber(fields.impa, 70, 110);
    out.incisorShift = clampNumber(fields.incisorShift, -5, 5);
    out.residual = clampNumber(fields.residual, 0, 10);
  }
  return out;
}

const SLOT_LABELS = {
  scanner:   '[3D 스캐너 / 구강 모형]',
  xray:      '[X-ray / 두부방사선]',
  faceFront: '[정면 안모]',
  faceSide:  '[측면 안모 / Profile]',
  intraoral: '[입술 벌린 정면 / Intraoral]'
};

const SLOT_DISPLAY = {
  scanner: '3D', xray: 'X-ray', faceFront: '정면', faceSide: '측면', intraoral: '입속'
};

function normalizeImages(body) {
  const out = [];
  if (body.images && typeof body.images === 'object') {
    for (const key of Object.keys(SLOT_LABELS)) {
      const img = body.images[key];
      if (img?.base64) {
        out.push({
          key,
          label: SLOT_LABELS[key],
          display: SLOT_DISPLAY[key],
          base64: img.base64,
          contentType: img.contentType || 'image/jpeg'
        });
      }
    }
  } else if (body.base64) {
    out.push({ key: 'scanner', label: SLOT_LABELS.scanner, display: SLOT_DISPLAY.scanner, base64: body.base64, contentType: body.contentType || 'image/jpeg' });
  }
  return out;
}

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};
  const { type } = body;

  if (!type || !SCHEMAS[type]) {
    return res.status(400).json({ error: `유효하지 않은 type: ${type}. 허용: ${Object.keys(SCHEMAS).join(', ')}` });
  }

  const images = normalizeImages(body);
  if (images.length === 0) {
    return res.status(400).json({ error: '최소 1장의 이미지(scanner/xray/faceFront/faceSide/intraoral 중 하나)가 필요합니다.' });
  }

  // 총 base64 크기 가드
  const totalBytes = images.reduce((s, i) => s + i.base64.length, 0);
  if (totalBytes > 45 * 1024 * 1024 * 1.4) {
    return res.status(413).json({ error: '이미지 합계가 너무 큽니다 (총 ~45MB 이내).' });
  }

  if (!GEMINI_API_KEY) {
    console.warn('[analyze-image] GEMINI_API_KEY 미설정 → 폴백 사용');
    return res.status(200).json({ ...fallbackFields(type), usedImages: images.map(i => i.display) });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SCHEMAS[type].instruction,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    // Gemini Vision 멀티 이미지 컨텐츠 빌드
    const parts = [];
    for (const img of images) {
      parts.push({ text: img.label });
      parts.push({ inlineData: { data: img.base64, mimeType: img.contentType } });
    }
    parts.push({ text: '위 이미지(들)를 분석하고 정의된 JSON 스키마로만 응답하세요.' });

    const result = await model.generateContent(parts);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn('[analyze-image] JSON 파싱 실패:', text.slice(0, 200));
      return res.status(200).json({ ...fallbackFields(type), usedImages: images.map(i => i.display) });
    }

    const cleaned = {
      fields: sanitizeFields(type, parsed.fields || {}),
      confidence: clampNumber(parsed.confidence, 0, 1) ?? 0.5,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '',
      usedImages: images.map(i => i.display),
      fallback: false
    };

    return res.status(200).json(cleaned);
  } catch (e) {
    console.error('[analyze-image] 실패:', e);
    return res.status(200).json({ ...fallbackFields(type), error: e.message, usedImages: images.map(i => i.display) });
  }
}
