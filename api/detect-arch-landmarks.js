import { isAzureChatConfigured, azureVisionCompletion } from '../lib/ai-provider.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = { api: { bodyParser: { sizeLimit: '15mb' } } };

const PROMPT = `이 사진은 치과 교정 환자의 하악(또는 상악) 교합면 사진입니다.

각 치아의 절단연(전치부) 또는 교두정(구치부)의 중앙 위치를 이미지 좌표로 찾아주세요.

규칙:
1. 좌측 제2대구치(#37 또는 #27)부터 시작하여 우측 제2대구치(#47 또는 #17)까지 순서대로 14개 포인트를 반환
2. 좌표는 이미지 너비/높이에 대한 비율(0~1)로 반환 (x=가로, y=세로)
3. 치아가 보이지 않거나 발치된 경우 인접 치아 사이의 중간점을 추정
4. 교합면(씹는 면)이 보이는 사진이므로, 각 치아의 가장 돌출된 점(교두정/절단연)을 정확히 찾기

반드시 아래 JSON 형식으로만 응답하세요:
{"points":[{"x":0.14,"y":0.32,"tooth":"37"},{"x":0.19,"y":0.38,"tooth":"36"},...14개],"arch":"lower","confidence":0.85}

arch는 "lower" 또는 "upper"로 하악/상악을 판별하세요.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { base64, contentType, imageWidth, imageHeight } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'base64 필수' });

    const mime = contentType || 'image/jpeg';
    let response;

    if (isAzureChatConfigured()) {
      response = await azureVisionCompletion({
        system: '치과 교정 전문 AI. 교합면 사진에서 치아 랜드마크 좌표를 정확히 검출합니다. JSON으로만 응답.',
        images: [{ base64, contentType: mime }],
        prompt: PROMPT,
        temperature: 0.1,
        timeoutMs: 30000
      });
    } else if (GEMINI_API_KEY) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent([
        { inlineData: { data: base64, mimeType: mime } },
        { text: PROMPT }
      ]);
      response = result.response.text();
    } else {
      return res.status(503).json({ error: 'AI API 키가 설정되지 않았습니다 (GEMINI_API_KEY 또는 AZURE_OPENAI)' });
    }

    // JSON 추출
    const jsonMatch = response.match(/\{[\s\S]*"points"[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(200).json({ success: false, error: 'AI 응답에서 좌표를 추출하지 못했습니다', raw: response.slice(0, 500) });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.points || !Array.isArray(parsed.points) || parsed.points.length < 5) {
      return res.status(200).json({ success: false, error: '포인트 수 부족', raw: response.slice(0, 500) });
    }

    // 비율 좌표를 픽셀 좌표로 변환 (이미지 크기가 제공된 경우)
    const w = imageWidth || 1;
    const h = imageHeight || 1;
    const pixelPoints = parsed.points.map(p => ({
      x: Math.round(p.x * w),
      y: Math.round(p.y * h),
      tooth: p.tooth
    }));

    return res.status(200).json({
      success: true,
      points: parsed.points,
      pixelPoints,
      arch: parsed.arch || 'lower',
      confidence: parsed.confidence || 0.7,
      count: parsed.points.length
    });
  } catch (e) {
    console.error('[detect-arch-landmarks]', e);
    return res.status(500).json({ error: e.message });
  }
}
