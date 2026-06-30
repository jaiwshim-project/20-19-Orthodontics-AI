import { azureVisionCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };

const SYSTEM_PROMPT = `You are an orthodontic measurement AI. Given a lower or upper occlusal photo, identify each tooth from left molar to right molar (14 teeth total) and measure the mesiodistal width of each tooth.

For each tooth, output:
- index: 1-14 (left to right in the photo)
- distalPoint: {x, y} pixel coordinate of the distal contact point
- mesialPoint: {x, y} pixel coordinate of the mesial contact point
- note: tooth name (e.g. "좌측 제2대구치")

Also detect any ruler/scale reference in the image and output:
- rulerDetected: true/false
- rulerStartPx: {x, y} (start of 10mm segment)
- rulerEndPx: {x, y} (end of 10mm segment)
- rulerLengthMm: number (real length of the detected segment)

If no ruler is visible, estimate pxPerMm using the molarDistanceMm parameter (distance between leftmost and rightmost molar centers).

Output ONLY valid JSON with this structure:
{
  "success": true,
  "teeth": [{index, distalPoint: {x,y}, mesialPoint: {x,y}, note}],
  "rulerDetected": false,
  "pxPerMm": number,
  "confidence": number (0-1),
  "arch": "lower" or "upper"
}`;

function buildUserPrompt(arch, imageWidth, imageHeight, molarDistanceMm) {
  return `Analyze this ${arch} occlusal photo (${imageWidth}x${imageHeight}px).
Identify all visible teeth from left to right (up to 14).
For each tooth, mark the distal point and mesial point at the widest mesiodistal dimension (contact points or widest buccolingual section projected onto the arch line).
The distance between tooth #1 (leftmost molar center) and tooth #14 (rightmost molar center) is approximately ${molarDistanceMm}mm in real life. Use this to estimate pxPerMm if no ruler is visible.
Return ONLY the JSON object.`;
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
    if (isAzureChatConfigured()) {
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
      return res.status(500).json({ error: 'AI provider not configured (GEMINI_API_KEY or Azure OpenAI required)' });
    }

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI response parsing failed', raw: response.slice(0, 500) });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.teeth || !Array.isArray(parsed.teeth)) {
      return res.status(500).json({ error: 'AI did not return teeth array', raw: response.slice(0, 500) });
    }

    // 좌표를 원본 이미지 크기로 보정 (AI가 축소된 이미지 기준으로 응답할 수 있음)
    const teeth = parsed.teeth.map(t => ({
      index: Number(t.index),
      distalPoint: { x: Math.round(Number(t.distalPoint?.x || 0)), y: Math.round(Number(t.distalPoint?.y || 0)) },
      mesialPoint: { x: Math.round(Number(t.mesialPoint?.x || 0)), y: Math.round(Number(t.mesialPoint?.y || 0)) },
      note: t.note || ''
    })).filter(t => t.index >= 1 && t.index <= 14 && t.distalPoint.x > 0 && t.mesialPoint.x > 0);

    return res.status(200).json({
      success: true,
      teeth,
      rulerDetected: !!parsed.rulerDetected,
      pxPerMm: Number(parsed.pxPerMm) || null,
      confidence: Number(parsed.confidence) || 0.7,
      arch: archType
    });

  } catch (e) {
    console.error('[measure-tooth-widths]', e);
    return res.status(500).json({ error: e.message });
  }
}
