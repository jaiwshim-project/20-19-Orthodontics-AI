import { azureVisionCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const SYSTEM_PROMPT = `You are an orthodontic measurement AI. Given a lower or upper occlusal photo, identify each tooth from left molar to right molar (14 teeth total) and measure the mesiodistal width of each tooth in millimeters.

CRITICAL SCALE RULE:
- The user provides molarDistanceMm = the real-world distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar).
- Use this as the ONLY scale reference.
- Measure each tooth's mesiodistal width as a proportion of this known distance, then convert to mm.
- The sum of all 14 tooth widths (TTL) should typically be 95-115mm for a normal adult dentition.

For each tooth, output:
- index: 1-14 (left to right in the photo)
- widthMm: mesiodistal width in millimeters (calculated using the molarDistanceMm scale)
- note: tooth name (e.g. "좌측 제2대구치")

Output ONLY valid JSON with this structure:
{
  "success": true,
  "teeth": [{"index": 1, "widthMm": 10.5, "note": "좌측 제2대구치"}, ...],
  "ttlMm": number (sum of all widthMm),
  "confidence": number (0-1),
  "arch": "lower" or "upper"
}`;

function buildUserPrompt(arch, imageWidth, imageHeight, molarDistanceMm) {
  return `Analyze this ${arch} occlusal photo (${imageWidth}x${imageHeight}px).
Identify all visible teeth from left to right (up to 14).
SCALE: The distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar) is ${molarDistanceMm}mm.
Measure each tooth's mesiodistal width in mm using this scale.
Return ONLY the JSON object with widthMm for each tooth and ttlMm as the sum.`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { base64, contentType, arch, imageWidth, imageHeight, molarDistanceMm } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 image required' });

    const archType = arch === 'upper' ? 'upper' : 'lower';
    const width = Number(imageWidth) || 1200;
    const height = Number(imageHeight) || 900;
    const molarMm = Number(molarDistanceMm) || 54;
    const userPrompt = buildUserPrompt(archType, width, height, molarMm);

    let response;
    if (ANTHROPIC_API_KEY) {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 3000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: contentType || 'image/jpeg', data: base64 } },
            { type: 'text', text: userPrompt }
          ]}]
        })
      });
      const anthropicData = await anthropicRes.json();
      if (!anthropicRes.ok) throw new Error(anthropicData?.error?.message || 'Anthropic API error');
      response = (anthropicData.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    } else if (isAzureChatConfigured()) {
      response = await azureVisionCompletion({
        system: SYSTEM_PROMPT,
        images: [{ base64, contentType: contentType || 'image/jpeg' }],
        prompt: userPrompt,
        temperature: 0.1,
        timeoutMs: 30000
      });
    } else if (GEMINI_API_KEY) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent([
        { text: SYSTEM_PROMPT + '\n\n' + userPrompt },
        { inlineData: { data: base64, mimeType: contentType || 'image/jpeg' } }
      ]);
      response = result.response.text();
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI response parsing failed', raw: response.slice(0, 500) });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.teeth || !Array.isArray(parsed.teeth)) {
      return res.status(500).json({ error: 'AI did not return teeth array', raw: response.slice(0, 500) });
    }

    // AI가 mm 단위로 직접 반환
    const teeth = parsed.teeth.map(t => ({
      index: Number(t.index),
      widthMm: Number(t.widthMm) || 0,
      note: t.note || ''
    })).filter(t => t.index >= 1 && t.index <= 14 && t.widthMm > 0);

    const ttlMm = Number(parsed.ttlMm) || teeth.reduce((s, t) => s + t.widthMm, 0);

    return res.status(200).json({
      success: true,
      teeth,
      ttlMm: Math.round(ttlMm * 100) / 100,
      confidence: Number(parsed.confidence) || 0.7,
      arch: archType
    });

  } catch (e) {
    console.error('[measure-tooth-widths]', e);
    return res.status(500).json({ error: e.message });
  }
}
