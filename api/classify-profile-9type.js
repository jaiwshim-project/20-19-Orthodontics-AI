import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  azureVisionCompletion, isAzureChatConfigured,
  anthropicVisionCompletion, isAnthropicConfigured, ANTHROPIC_MODEL_VISION
} from '../lib/ai-provider.js';
import { safeErrorMessage } from '../lib/safe-error.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = {
  api: { bodyParser: { sizeLimit: '18mb' } }
};

const PROFILES = ['concave', 'straight', 'convex'];
const VERTICALS = ['dolicho', 'meso', 'brachy'];
const PROFILE_LABELS = { concave: 'Concave', straight: 'Straight', convex: 'Convex' };
const VERTICAL_LABELS = { dolicho: 'Dolicho', meso: 'Meso', brachy: 'Brachy' };
const PROFILE_KO = { concave: '오목형', straight: '직선형', convex: '볼록형' };
const VERTICAL_KO = { dolicho: '장안형', meso: '중안형', brachy: '단안형' };

const SYSTEM_PROMPT = `You are an orthodontic facial profile classification assistant.
Classify one patient lateral facial/profile image into exactly one of 9 types using two axes:
- Profile axis: concave, straight, convex
- Vertical pattern axis: dolicho, meso, brachy

Use visual inspection only. Treat this as a clinical support classification, not a definitive diagnosis.
Concave: relatively retrusive midface/maxilla or prominent mandible/chin, inward facial convexity.
Straight: balanced forehead/nose/lips/chin profile, neither clearly concave nor convex.
Convex: retrusive mandible/chin or protrusive maxilla/lips, outward facial convexity.
Dolicho: long vertical facial pattern, increased lower facial height, steep mandibular plane tendency, lip incompetence/open bite tendency if visible.
Meso: average vertical proportions.
Brachy: short vertical facial pattern, strong/low mandibular angle tendency, reduced lower facial height/deep bite tendency if visible.

Return Korean JSON only with this exact shape:
{
  "profile": "concave" | "straight" | "convex",
  "verticalPattern": "dolicho" | "meso" | "brachy",
  "type": "Concave / Dolicho" | "Concave / Meso" | "Concave / Brachy" | "Straight / Dolicho" | "Straight / Meso" | "Straight / Brachy" | "Convex / Dolicho" | "Convex / Meso" | "Convex / Brachy",
  "confidence": number,
  "evidence": string[],
  "clinicalNotes": string[],
  "limitations": string[]
}`;

function normalizeImage(image) {
  if (!image || !image.base64) return null;
  const raw = String(image.base64);
  const match = raw.match(/^data:(.*?);base64,(.*)$/);
  return {
    key: image.key || 'faceLateral',
    label: image.label || '환자 측면 얼굴 사진',
    contentType: image.contentType || image.type || match?.[1] || 'image/jpeg',
    base64: match ? match[2] : raw
  };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

function normalizeResult(parsed, provider) {
  const profile = String(parsed?.profile || '').toLowerCase();
  const vertical = String(parsed?.verticalPattern || parsed?.vertical || '').toLowerCase();
  if (!PROFILES.includes(profile) || !VERTICALS.includes(vertical)) {
    throw new Error('AI가 유효한 9유형 축 값을 반환하지 않았습니다.');
  }
  let confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.55;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
  confidence = Math.max(0, Math.min(0.95, confidence));
  return {
    success: true,
    source: provider,
    profile,
    verticalPattern: vertical,
    type: `${PROFILE_LABELS[profile]} / ${VERTICAL_LABELS[vertical]}`,
    profileLabel: PROFILE_KO[profile],
    verticalLabel: VERTICAL_KO[vertical],
    confidence: Number(confidence.toFixed(2)),
    evidence: Array.isArray(parsed?.evidence) ? parsed.evidence.slice(0, 6) : [],
    clinicalNotes: Array.isArray(parsed?.clinicalNotes) ? parsed.clinicalNotes.slice(0, 6) : [],
    limitations: Array.isArray(parsed?.limitations) ? parsed.limitations.slice(0, 4) : []
  };
}

function unavailableResult(message) {
  return {
    success: false,
    error: message,
    code: 'PROFILE_9TYPE_AI_UNAVAILABLE'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const image = normalizeImage(req.body?.image);
    if (!image) return res.status(400).json({ success: false, error: '측면 얼굴 이미지가 필요합니다.' });

    const prompt = `Analyze the provided patient lateral facial image and classify it into one of the 9 profile types. Use the reference taxonomy: Concave/Straight/Convex by facial convexity, and Dolicho/Meso/Brachy by vertical facial proportion. Return JSON only.`;
    const images = [{ ...image, label: `[${image.label}]` }];

    let text;
    let provider = 'unknown';
    if (isAnthropicConfigured()) {
      provider = `anthropic:${ANTHROPIC_MODEL_VISION}`;
      text = await anthropicVisionCompletion({
        system: SYSTEM_PROMPT,
        prompt,
        images,
        maxTokens: 1200,
        temperature: 0.05,
        timeoutMs: 45000
      });
    } else if (isAzureChatConfigured()) {
      provider = 'azure-openai';
      text = await azureVisionCompletion({
        system: SYSTEM_PROMPT,
        prompt,
        images,
        responseFormat: 'json',
        temperature: 0.05,
        timeoutMs: 45000
      });
    } else if (GEMINI_API_KEY) {
      provider = 'gemini';
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent([
        { inlineData: { data: image.base64, mimeType: image.contentType } },
        { text: `${SYSTEM_PROMPT}\n\n${prompt}` }
      ]);
      text = result.response.text();
    } else {
      return res.status(503).json(unavailableResult('AI 이미지 분석 키가 설정되어 있지 않습니다.'));
    }

    const parsed = parseJson(text);
    if (!parsed) throw new Error('AI 응답 JSON 파싱 실패');
    return res.status(200).json(normalizeResult(parsed, provider));
  } catch (error) {
    console.error('[classify-profile-9type]', error);
    return res.status(500).json({ success: false, error: safeErrorMessage(error) });
  }
}
