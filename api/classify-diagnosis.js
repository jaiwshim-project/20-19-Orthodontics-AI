import { GoogleGenerativeAI } from '@google/generative-ai';
import { azureVisionCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

export const config = {
  api: { bodyParser: { sizeLimit: '18mb' } }
};

const REQUIRED_IMAGES = ['ceph', 'leftLateral', 'rightLateral'];

const SYSTEM_PROMPT = `You are an orthodontic classification assistant.
Classify malocclusion using ONLY these three images:
1. lateral cephalometric image
2. left intraoral lateral photo
3. right intraoral lateral photo

Do not use manually entered numeric values such as ANB, FMA, IMPA, crowding, overjet, overbite, profile, lip strain, or molar relation. If a finding cannot be verified visually from the three images, mark it as estimated or uncertain.

Classification logic:
- Use lateral cephalometric image for skeletal tendency: Class I / II / III, convexity, mandibular retrusion/protrusion, maxillary protrusion/retrusion, vertical tendency.
- Use right and left intraoral lateral photos for dental/Angle relationship: canine and molar relationship if visible, overjet, overbite, anterior crossbite, edge-to-edge, Class II/III asymmetry.
- Final class should integrate skeletal and dental evidence from the three images only.

CRITICAL — Crowding vs. skeletal Class II differentiation:
- Severe crowding can cause labial displacement/tipping of upper incisors, mimicking increased overjet. Do NOT classify as Class II based on apparent overjet alone when crowding is present.
- When significant crowding is visible, prioritize MOLAR RELATIONSHIP (first molar key) over incisor position for Angle classification.
- If upper canines are ectopic/high or teeth are severely displaced, evaluate the skeletal jaw relationship from ceph (SNA-SNB, Wits, profile convexity) INDEPENDENTLY from the dental crowding.
- Class II diagnosis requires BOTH: (1) skeletal evidence from cephalometric (convex profile, mandibular retrusion, or maxillary protrusion) AND (2) Class II molar/canine relationship visible in intraoral photos.
- If molar relationship appears Class I but incisors look protruded due to crowding → classify as Class I with crowding, NOT Class II.

Return Korean JSON only with this shape:
{
  "classification": {
    "angleClass": "Class I" | "Class II Division 1" | "Class II Division 2" | "Class III" | "Indeterminate",
    "skeletalPattern": "skeletal" | "dental" | "combination" | "uncertain",
    "severity": "mild" | "moderate" | "severe" | "uncertain",
    "confidence": number,
    "evidence": string[],
    "keyFindings": string[]
  },
  "measurements": {
    "skeletalRelation": string,
    "dentalRelation": string,
    "verticalPattern": "normal" | "hyperdivergent" | "hypodivergent" | "uncertain",
    "profileType": string,
    "imageBasis": string[]
  },
  "treatmentPlan": {
    "summary": string,
    "approach": "non_extraction" | "extraction" | "two_phase" | "surgical" | "hybrid" | "needs_records",
    "phases": [],
    "total_duration_months": null,
    "estimated_cost_krw": { "min": null, "max": null },
    "retention_plan": string,
    "prognosis": string
  },
  "risks": string[],
  "alternatives": string[],
  "patientEducation": string[]
}`;

function normalizeImage(image) {
  if (!image || !image.base64) return null;
  const raw = String(image.base64);
  const match = raw.match(/^data:(.*?);base64,(.*)$/);
  return {
    key: image.key,
    label: image.label || image.key,
    contentType: image.contentType || image.type || match?.[1] || 'image/jpeg',
    base64: match ? match[2] : raw
  };
}


async function anthropicVisionCompletion({ system, prompt, images, timeoutMs = 45000 }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const content = [];
    for (const image of images) {
      content.push({ type: 'text', text: `[${image.label || image.key}]` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.contentType || 'image/jpeg',
          data: image.base64
        }
      });
    }
    content.push({ type: 'text', text: prompt });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2200,
        system,
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `Anthropic request failed: HTTP ${response.status}`);
    }
    return (data.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  } finally {
    clearTimeout(timer);
  }
}
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}


function publicAiError(error) {
  const message = String(error?.message || error || '');
  if (/CONSUMER_SUSPENDED|Permission denied|403|api[_-]?key/i.test(message)) {
    return {
      status: 503,
      error: '이미지 기반 AI 분류 서비스 키가 비활성화되었거나 권한이 없습니다. 관리자에게 API 키 재설정을 요청하세요.',
      code: 'AI_PROVIDER_UNAVAILABLE'
    };
  }
  if (/quota|rate|429/i.test(message)) {
    return {
      status: 503,
      error: '이미지 기반 AI 분류 서비스 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
      code: 'AI_RATE_LIMITED'
    };
  }
  return {
    status: 500,
    error: '이미지 기반 AI 분류 중 오류가 발생했습니다. 서버 로그를 확인하세요.',
    code: 'AI_CLASSIFICATION_FAILED'
  };
}

function fallbackResult(message) {
  return {
    success: true,
    source: 'image-only-unavailable',
    classification: {
      angleClass: 'Indeterminate',
      skeletalPattern: 'uncertain',
      severity: 'uncertain',
      confidence: 0,
      evidence: [message],
      keyFindings: [message]
    },
    measurements: {
      skeletalRelation: '이미지 기반 분석 불가',
      dentalRelation: '이미지 기반 분석 불가',
      verticalPattern: 'uncertain',
      profileType: 'uncertain',
      imageBasis: []
    },
    treatmentPlan: {
      summary: '세팔로 측면, 구강 좌측면, 구강 우측면 사진 기반 분석을 실행할 수 없습니다.',
      approach: 'needs_records',
      phases: [],
      total_duration_months: null,
      estimated_cost_krw: { min: null, max: null },
      retention_plan: '추가 자료 확인 후 결정',
      prognosis: '추가 자료 필요'
    },
    risks: ['이미지 기반 AI 설정 또는 필수 사진이 부족합니다.'],
    alternatives: ['필수 3장 사진을 다시 업로드한 후 재분류하세요.'],
    patientEducation: ['이 분류는 세팔로 측면, 구강 좌측면, 구강 우측면 사진만 사용하도록 설정되어 있습니다.']
  };
}
function calibrateConfidence(result) {
  const cls = result?.classification;
  if (!cls) return result;

  let confidence = Number(cls.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
  confidence = Math.max(0, Math.min(0.95, confidence));

  const angleClass = String(cls.angleClass || cls.class || '');
  const severity = String(cls.severity || '');
  const evidence = [
    ...(Array.isArray(cls.evidence) ? cls.evidence : []),
    ...(Array.isArray(cls.keyFindings) ? cls.keyFindings : []),
    ...(Array.isArray(result.measurements?.imageBasis) ? result.measurements.imageBasis : [])
  ];
  const evidenceText = evidence.join(' ').toLowerCase();
  const evidenceCount = evidence.filter(Boolean).length;

  if (/indeterminate|uncertain/i.test(angleClass) || severity === 'uncertain') {
    cls.confidence = Math.min(confidence, 0.49);
    return result;
  }

  const hasCeph = /ceph|cephalometric|세팔|측모|lateral/.test(evidenceText);
  const hasLeft = /left|좌측|왼쪽/.test(evidenceText);
  const hasRight = /right|우측|오른쪽/.test(evidenceText);
  const bilateral = hasLeft && hasRight;

  if (evidenceCount >= 2) confidence = Math.max(confidence, 0.62);
  if (evidenceCount >= 3 && hasCeph) confidence = Math.max(confidence, 0.68);
  if (evidenceCount >= 4 && hasCeph && bilateral) confidence = Math.max(confidence, 0.76);

  if (/class ii division 1/i.test(angleClass)) {
    const supportSignals = [
      /overjet|수평피개|돌출/.test(evidenceText),
      /proclin|incisor|전치/.test(evidenceText),
      /convex|retrus|후퇴|볼록/.test(evidenceText),
      /molar|canine|구치|견치/.test(evidenceText),
      bilateral
    ].filter(Boolean).length;
    if (supportSignals >= 3) confidence = Math.max(confidence, 0.75);
    if (supportSignals >= 4 && hasCeph) confidence = Math.max(confidence, 0.82);
  }

  if (!bilateral) confidence = Math.min(confidence, 0.70);
  cls.confidence = Number(confidence.toFixed(2));
  return result;
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const images = (req.body?.images || []).map(normalizeImage).filter(Boolean);
    const byKey = Object.fromEntries(images.map(img => [img.key, img]));
    const missing = REQUIRED_IMAGES.filter(key => !byKey[key]);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `?꾩닔 ?대?吏媛 遺議깊빀?덈떎: ${missing.join(', ')}`
      });
    }

    const selectedImages = REQUIRED_IMAGES.map(key => byKey[key]);
    const prompt = `Classify Angle malocclusion using only these 3 images: lateral cephalometric, left intraoral lateral, and right intraoral lateral.
Do not use any manual numeric values or default form values.
For every conclusion, state which image supports it in evidence.

IMPORTANT — Before classifying:
1. First assess if CROWDING is present (displaced/rotated teeth, ectopic canines, lack of space).
2. If crowding is significant, do NOT interpret labially displaced incisors as "increased overjet" — that is dental displacement, not skeletal Class II.
3. Always verify molar relationship (Class I/II/III key) separately from incisor position.
4. For Class II diagnosis, you MUST confirm BOTH skeletal (ceph: convex profile, mandibular retrusion) AND dental (molar/canine Class II relationship) evidence. Apparent incisor protrusion from crowding alone is NOT sufficient.

Calibrate confidence with this rubric:
- 0.40-0.59: limited visibility, unilateral evidence, or conflicting findings.
- 0.60-0.74: likely classification with at least two supporting visual findings.
- 0.75-0.88: consistent cephalometric tendency plus matching left and right intraoral lateral findings.
- 0.89-0.95: very clear bilateral dental relationship and cephalometric profile with no meaningful conflict.
- Do not exceed 0.70 if either left or right intraoral lateral relationship is not visible.
- For Class II Division 1, use 0.75 or higher only when increased overjet/proclined upper incisors or convex/retrusive mandibular pattern is visible AND at least one side supports Class II canine/molar tendency.
- If crowding is severe and molar relationship is Class I, classify as Class I regardless of apparent incisor protrusion.`;

    let text;
    if (ANTHROPIC_API_KEY) {
      text = await anthropicVisionCompletion({
        system: SYSTEM_PROMPT,
        prompt,
        images: selectedImages,
        timeoutMs: 45000
      });
    } else if (isAzureChatConfigured()) {
      text = await azureVisionCompletion({
        system: SYSTEM_PROMPT,
        prompt,
        images: selectedImages,
        responseFormat: 'json',
        temperature: 0.1,
        timeoutMs: 45000
      });
    } else if (GEMINI_API_KEY) {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const parts = [];
      for (const image of selectedImages) {
        parts.push({ text: `[${image.label}]` });
        parts.push({ inlineData: { data: image.base64, mimeType: image.contentType } });
      }
      parts.push({ text: prompt });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      });
      text = result.response.text();
    } else {
      return res.status(503).json(fallbackResult('?대?吏 湲곕컲 遺꾨쪟瑜??꾪븳 AI API ?ㅺ? ?ㅼ젙?섏? ?딆븯?듬땲??'));
    }

    const parsed = parseJson(text);
    if (!parsed) {
      return res.status(502).json(fallbackResult('AI ?묐떟?먯꽌 JSON 遺꾨쪟 寃곌낵瑜?異붿텧?섏? 紐삵뻽?듬땲??'));
    }

    return res.status(200).json({
      success: true,
      source: 'image-only-ai',
      usedImages: REQUIRED_IMAGES,
      ...calibrateConfidence(parsed)
    });
  } catch (error) {
    console.error('[classify-diagnosis]', error);
    const publicError = publicAiError(error);
    return res.status(publicError.status).json({ success: false, error: publicError.error, code: publicError.code });
  }
}


