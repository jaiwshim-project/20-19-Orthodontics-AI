import { GoogleGenerativeAI } from '@google/generative-ai';
import { searchKnowledge, saveConversation } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 교정치과 전문 AI 어시스턴트입니다.
- 의학적 근거를 기반으로 답변하고, 가능한 출처를 인용하세요.
- 답변은 명료한 한국어로 작성하되, 핵심 의학 용어는 영문 병기하세요.
- 진단을 단정하지 말고 임상 판단의 보조 자료임을 명시하세요.
- 환자가 어린이(만 17세 이하)인 경우 성장 단계와 비발치 가능성을 우선 고려하세요.
- 모든 측정값은 단위(mm/도)와 함께 제시하세요.`;

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try {
      return Buffer.from(text, 'latin1').toString('utf8');
    } catch {
      return text;
    }
  }
  return text;
}

function normalizeBody(body) {
  if (!body) return {};
  const normalized = { ...body };
  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map(m => ({
      role: m.role,
      content: fixKoreanEncoding(m.content)
    }));
  }
  if (normalized.context) normalized.context = fixKoreanEncoding(normalized.context);
  return normalized;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = normalizeBody(req.body);
    const { messages = [], model = 'gemini-1.5-flash', userId } = body;

    if (!messages.length) {
      return res.status(400).json({ error: 'messages가 비어있습니다.' });
    }

    if (!GEMINI_API_KEY) {
      console.warn('[chat] GEMINI_API_KEY 미설정 → 안내 응답 반환');
      return res.status(200).json({
        reply: '죄송합니다. AI 서비스 키가 설정되지 않아 답변을 생성할 수 없습니다. 관리자에게 GEMINI_API_KEY 설정을 요청해 주세요.',
        sources: [],
        usage: { model: 'fallback' },
        fallback: true
      });
    }

    const userQuery = messages[messages.length - 1]?.content || '';
    let sources = [];
    try {
      sources = await searchKnowledge(userQuery, 3);
    } catch (e) {
      console.warn('[chat] RAG 건너뜀:', e.message);
    }

    const ragContext = sources.length
      ? `\n\n참고 지식:\n${sources.map((s, i) => `[${i + 1}] ${s.content}`).join('\n')}`
      : '';

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: SYSTEM_PROMPT + ragContext
    });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const chat = geminiModel.startChat({ history });
    const result = await chat.sendMessage(userQuery);
    const reply = result.response.text();

    if (userId) {
      try {
        await saveConversation(userId, [...messages, { role: 'assistant', content: reply }]);
      } catch (e) {
        console.warn('[chat] 대화 저장 실패:', e.message);
      }
    }

    return res.status(200).json({
      reply,
      sources: sources.map(s => ({ source: s.source, snippet: s.content?.slice(0, 200) })),
      usage: { model }
    });
  } catch (e) {
    console.error('[chat] 처리 실패:', e);
    return res.status(500).json({ error: e.message || '내부 서버 오류' });
  }
}
