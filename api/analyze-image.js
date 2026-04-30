import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SCHEMAS = {
  extraction: {
    instruction: `당신은 교정치과 영상 분석 AI입니다.
입력된 측면 두부방사선 또는 구강 사진을 분석해 다음 측정값을 JSON으로 반환하세요.
관찰이 어려우면 null을 반환하고, 관찰 가능하면 합리적 추정값을 제시하세요.
반드시 다음 스키마:
{
  "fields": {
    "anb": number | null,        // ANB 각 (도)
    "crowding": number | null,   // 부조화 (mm)
    "overjet": number | null,    // (mm)
    "overbite": number | null,   // (mm)
    "profile": "straight"|"convex"|"concave" | null,
    "lipStrain": "none"|"mild"|"severe" | null,
    "fma": number | null,        // FMA (도)
    "impa": number | null        // IMPA (도)
  },
  "confidence": number,           // 0-1
  "notes": string                 // 관찰 소견 한 줄 — 반드시 한국어
}
중요: notes는 반드시 한국어로 작성하세요. 의학 용어는 영문 병기 가능.`
  },
  growth: {
    instruction: `당신은 골성숙 단계 분석 AI입니다.
입력된 손목 X-ray(Hand-wrist) 또는 측면 두부방사선의 경추(C2-C4)를 관찰해 골연령과 CVMS 단계를 추정하세요.
스키마:
{
  "fields": {
    "boneAge": number | null,        // 추정 골연령 (세)
    "cvms": 1|2|3|4|5|6 | null,      // CVMS 단계
    "height": null,                  // 사진으로 측정 불가 — null
    "weight": null                   // 사진으로 측정 불가 — null
  },
  "confidence": number,
  "notes": string
}
신장·체중은 사진에서 추출할 수 없으므로 항상 null. 골성숙 지표(MP3, sesamoid, distal phalanx)를 관찰 후 판단.
중요: notes는 반드시 한국어로 작성하세요.`
  },
  facial: {
    instruction: `당신은 안모 분석 AI입니다.
입력된 측면 환자 사진을 분석해 현재 안모 상태와 권장되는 변화 방향을 mm 단위로 제시하세요.
양수 = 후방/내측 이동 권장, 음수 = 전방/외측. 0 = 변화 불필요.
스키마:
{
  "fields": {
    "maxRetract": number,    // 상악 후방 권장 (-2 ~ 6mm)
    "mandShift": number,     // 하악 전후방 (-5 ~ 5mm)
    "lipUpper": number,      // 상순 (-3 ~ 3mm)
    "lipLower": number,      // 하순 (-3 ~ 3mm)
    "chin": number           // 턱 (-3 ~ 3mm)
  },
  "confidence": number,
  "notes": string
}
관찰: 입술 돌출, 턱 후퇴, E-line 관계.
중요: notes는 반드시 한국어로 작성하세요.`
  },
  recurrence: {
    instruction: `당신은 치료 종료 시점의 교정 결과를 분석하는 AI입니다.
입력된 측면 ceph 또는 모형 사진을 보고 다음을 추정하세요.
스키마:
{
  "fields": {
    "impa": number | null,         // 치료 후 IMPA (도)
    "incisorShift": number | null, // 하악 절치 위치 변화 추정 (mm, +가 전방)
    "residual": number | null      // 잔여 Crowding (mm)
  },
  "confidence": number,
  "notes": string
}
중요: notes는 반드시 한국어로 작성하세요.`
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

export const config = {
  api: { bodyParser: { sizeLimit: '25mb' } }
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { type, base64, contentType = 'image/jpeg' } = req.body || {};

  if (!type || !SCHEMAS[type]) {
    return res.status(400).json({ error: `유효하지 않은 type: ${type}. 허용: ${Object.keys(SCHEMAS).join(', ')}` });
  }
  if (!base64) {
    return res.status(400).json({ error: 'base64 이미지 데이터가 필요합니다.' });
  }

  // 이미지 크기 가드 (base64는 약 1.33배 부풀음)
  if (base64.length > 25 * 1024 * 1024 * 1.4) {
    return res.status(413).json({ error: '이미지가 너무 큽니다 (최대 ~25MB).' });
  }

  if (!GEMINI_API_KEY) {
    console.warn('[analyze-image] GEMINI_API_KEY 미설정 → 폴백 사용');
    return res.status(200).json(fallbackFields(type));
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SCHEMAS[type].instruction,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    const result = await model.generateContent([
      { inlineData: { data: base64, mimeType: contentType } },
      { text: '이미지를 분석하고 정의된 JSON 스키마로만 응답하세요.' }
    ]);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn('[analyze-image] JSON 파싱 실패:', text.slice(0, 200));
      return res.status(200).json(fallbackFields(type));
    }

    const cleaned = {
      fields: sanitizeFields(type, parsed.fields || {}),
      confidence: clampNumber(parsed.confidence, 0, 1) ?? 0.5,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 400) : '',
      fallback: false
    };

    return res.status(200).json(cleaned);
  } catch (e) {
    console.error('[analyze-image] 실패:', e);
    return res.status(200).json({ ...fallbackFields(type), error: e.message });
  }
}
