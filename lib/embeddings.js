import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function getClient() {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.');
  }
  return new GoogleGenerativeAI(GEMINI_API_KEY);
}

export async function embed(text) {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  // outputDimensionality 768로 고정해 pgvector 스키마(vector(768))와 호환 유지
  const result = await model.embedContent({
    content: { parts: [{ text }] },
    outputDimensionality: 768
  });
  return result.embedding.values;
}

export async function embedBatch(texts, concurrency = 4) {
  const out = new Array(texts.length);
  let i = 0;
  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      try {
        out[idx] = await embed(texts[idx]);
      } catch (e) {
        console.error(`[embeddings] 인덱스 ${idx} 실패:`, e.message);
        out[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
