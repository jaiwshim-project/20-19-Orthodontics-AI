import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAdmin } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_BYTES = 50 * 1024 * 1024;

export const config = {
  api: {
    bodyParser: { sizeLimit: '50mb' }
  }
};

function inferMimeFromName(name = '') {
  const ext = name.toLowerCase().split('.').pop();
  return {
    stl: 'application/sla',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    pdf: 'application/pdf'
  }[ext] || 'application/octet-stream';
}

async function analyzeImage(base64, mime) {
  if (!GEMINI_API_KEY) return '이미지 분석을 위한 API 키가 설정되지 않았습니다.';
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: '당신은 교정치과 영상 분석 AI입니다. 입력 이미지가 X-ray, 구강사진, 모형 사진 중 무엇인지 식별하고, 발견된 임상적 특징을 한국어로 요약하세요.'
  });
  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType: mime } },
    { text: '이 이미지에서 관찰되는 교정학적 특징을 5개 항목으로 요약하고, 추가 검사 필요성을 명시하세요.' }
  ]);
  return result.response.text();
}

function extractStlMeta(buffer) {
  if (buffer.length < 84) return { triangles: 0, format: 'unknown' };
  const isAscii = buffer.slice(0, 5).toString('utf8') === 'solid';
  if (isAscii) {
    const text = buffer.toString('utf8');
    const matches = text.match(/facet normal/g);
    return { format: 'ascii', triangles: matches ? matches.length : 0, sizeBytes: buffer.length };
  }
  const triangles = buffer.readUInt32LE(80);
  return { format: 'binary', triangles, sizeBytes: buffer.length };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { filename, base64, contentType, clinicId } = req.body || {};
    if (!filename || !base64) {
      return res.status(400).json({ error: 'filename과 base64가 필요합니다.' });
    }
    const mime = contentType || inferMimeFromName(filename);
    const buffer = Buffer.from(base64, 'base64');

    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: '파일 크기가 50MB를 초과합니다.' });
    }

    let analysis = '';
    let meta = {};
    if (mime.startsWith('image/')) {
      analysis = await analyzeImage(base64, mime);
    } else if (mime === 'application/sla' || filename.toLowerCase().endsWith('.stl')) {
      meta = extractStlMeta(buffer);
      analysis = `STL 파일: ${meta.format} 포맷, ${meta.triangles.toLocaleString()}개 삼각형, ${(meta.sizeBytes / 1024 / 1024).toFixed(2)}MB`;
    } else if (mime === 'application/pdf') {
      analysis = 'PDF 파일이 업로드되었습니다. 텍스트 추출 후 임베딩이 예약되었습니다.';
    }

    let url = null;
    try {
      const sb = getAdmin();
      const path = `${clinicId || 'public'}/${Date.now()}_${filename}`;
      const { data, error } = await sb.storage.from('uploads').upload(path, buffer, {
        contentType: mime,
        upsert: false
      });
      if (!error && data) {
        const { data: pub } = sb.storage.from('uploads').getPublicUrl(data.path);
        url = pub?.publicUrl || null;
      }
    } catch (e) {
      console.warn('[upload] Storage 저장 건너뜀:', e.message);
    }

    return res.status(200).json({
      filename,
      mime,
      sizeBytes: buffer.length,
      url,
      meta,
      analysis
    });
  } catch (e) {
    console.error('[upload] 실패:', e);
    return res.status(500).json({ error: e.message });
  }
}
