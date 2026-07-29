import {
  isAzureChatConfigured, azureVisionCompletion,
  anthropicVisionCompletion, isAnthropicConfigured, ANTHROPIC_MODEL_VISION
} from '../lib/ai-provider.js';
import { safeErrorMessage } from '../lib/safe-error.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const PROMPT = `You are an orthodontic image segmentation assistant for occlusal intraoral photos.

Analyze the image and return EZ/TZ landmarks as normalized image coordinates.

Definitions:
- TZ curve: red tooth-zone curve. It follows the dental arch through tooth anatomy. Posterior molar/premolar points should be at the tooth center. Anterior/canine points should follow the incisal edge or cusp tip line. The curve starts and ends at the center of the left and right molars closest to the occlusal plane.
- EZ curve: blue equilibrium-zone curve. It is NOT based on tooth centers. It follows the center of the alveolar bone / dental arch basal bone corridor, inside the dental arch. It starts and ends at the same left/right molar center anchors used by TZ, then passes through the alveolar ridge center line.

Return 14 ordered points from patient-left posterior molar to patient-right posterior molar.

Important:
- Segment/identify visible tooth crown regions and alveolar ridge corridor visually.
- Keep all points on plausible dental or alveolar anatomy, not outside the mouth or on soft tissue glare.
- For mandibular occlusal images, the anterior teeth are typically near the lower/front side of the arch. For maxillary images, the anterior teeth are typically near the upper/front side.
- If uncertain, provide best-estimate points and lower confidence.

Respond ONLY with valid JSON in this schema:
{
  "arch": "lower" | "upper",
  "confidence": 0.0,
  "tzPoints": [{"x":0.0,"y":0.0,"tooth":"left_molar_2","role":"center|tip"}],
  "ezPoints": [{"x":0.0,"y":0.0,"role":"alveolar_center"}],
  "toothRegions": [{"label":"left_molar_2","cx":0.0,"cy":0.0,"x1":0.0,"y1":0.0,"x2":0.0,"y2":0.0}],
  "notes": ["short reason"]
}`;

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normalizePoint(point, width, height) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const nx = x > 1 ? x / width : x;
  const ny = y > 1 ? y / height : y;
  return { ...point, x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
}

function toPixelPoint(point, width, height) {
  return {
    x: Math.round(Number(point.x) * width),
    y: Math.round(Number(point.y) * height),
    tooth: point.tooth || point.label || null,
    role: point.role || null
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { base64, contentType, imageWidth, imageHeight } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 is required' });

    const mime = contentType || 'image/jpeg';
    let response;
    let provider = 'unknown';

    if (isAnthropicConfigured()) {
      provider = `anthropic:${ANTHROPIC_MODEL_VISION}`;
      response = await anthropicVisionCompletion({
        system: 'You are an orthodontic occlusal image segmentation assistant. Return only valid JSON.',
        images: [{ base64, contentType: mime, label: 'Occlusal intraoral photo' }],
        prompt: PROMPT,
        timeoutMs: 45000
      });
    } else if (isAzureChatConfigured()) {
      provider = 'azure-openai';
      response = await azureVisionCompletion({
        system: 'You are an orthodontic occlusal image segmentation assistant. Return only valid JSON.',
        images: [{ base64, contentType: mime }],
        prompt: PROMPT,
        temperature: 0.05,
        timeoutMs: 45000
      });
    } else if (GEMINI_API_KEY) {
      provider = 'gemini';
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.05, responseMimeType: 'application/json' } });
      const result = await model.generateContent([{ inlineData: { data: base64, mimeType: mime } }, { text: PROMPT }]);
      response = result.response.text();
    } else {
      return res.status(503).json({ error: 'AI API key is not configured. Set ANTHROPIC_API_KEY, Azure OpenAI, or GEMINI_API_KEY.' });
    }

    const jsonText = extractJson(response);
    if (!jsonText) return res.status(200).json({ success: false, provider, error: 'Could not extract JSON landmarks from AI response.', raw: String(response || '').slice(0, 700) });

    const parsed = JSON.parse(jsonText);
    const w = Number(imageWidth) || 1;
    const h = Number(imageHeight) || 1;
    const tzPoints = (parsed.tzPoints || parsed.points || []).map(point => normalizePoint(point, w, h)).filter(Boolean);
    const ezPoints = (parsed.ezPoints || []).map(point => normalizePoint(point, w, h)).filter(Boolean);

    if (tzPoints.length < 5) return res.status(200).json({ success: false, provider, error: 'AI returned too few TZ points.', raw: String(response || '').slice(0, 700) });

    const tzPixelPoints = tzPoints.map(point => toPixelPoint(point, w, h));
    const ezPixelPoints = ezPoints.length >= 5 ? ezPoints.map(point => toPixelPoint(point, w, h)) : [];

    return res.status(200).json({
      success: true,
      provider,
      segmentation: true,
      points: tzPoints,
      pixelPoints: tzPixelPoints,
      tzPoints,
      ezPoints,
      tzPixelPoints,
      ezPixelPoints,
      toothRegions: Array.isArray(parsed.toothRegions) ? parsed.toothRegions : [],
      arch: parsed.arch || 'lower',
      confidence: Number(parsed.confidence) || 0.65,
      count: tzPoints.length,
      ezCount: ezPoints.length,
      notes: Array.isArray(parsed.notes) ? parsed.notes : []
    });
  } catch (e) {
    console.error('[detect-arch-landmarks]', e);
    return res.status(500).json({ error: safeErrorMessage(e) });
  }
}
