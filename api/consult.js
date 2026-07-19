import { GoogleGenerativeAI } from '@google/generative-ai';
import { searchKnowledge, saveConversation } from '../lib/supabase.js';
import { azureChatCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

// ============================================================
// 환자 상담 AI — 김용을 원장 RAG 자료 기반
//   교정치과 환자에게 상담 내용을 쉬운 언어로 설명하는 어시스턴트.
//   knowledge_chunks(pgvector)에서 근거를 검색해 답변에 인용.
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 교정치과 원장을 돕는 "환자 상담 AI"입니다. 김용을 원장의 임상 이론과 자료를 근거로 환자에게 설명합니다.

[역할]
- 환자가 이해하기 쉬운 언어로 교정 치료를 설명합니다. 전문 용어는 반드시 쉬운 말로 풀어서 병기하세요. (예: "Crowding(치아가 자리 부족으로 겹친 상태)")
- 김용을 원장의 EZL/TTL 이론(Buccinator Mechanism)을 우선 근거로 활용합니다.
  · EZL(Equilibrium Zone Length, 노란 곡선): 혀와 볼·입술 압력이 균형을 이루는 안정적인 치열 공간의 길이
  · TTL(Total Tooth Length, 빨간 곡선): 실제 치아 폭의 합
  · TTL > EZL → 자리가 부족해 치아가 겹침(Crowding), 발치 검토
  · TTL < EZL → 공간이 남음(Spacing)
  · TTL ≈ EZL → 정상 배열

[답변 원칙]
- 아래 "참고 지식"에 김용을 원장 자료가 있으면 그 내용을 최우선으로 인용하고, 문장 끝에 [출처] 형태로 표기하세요.
- 진단을 단정하지 말고, 최종 판단은 담당 원장님과 상의해야 함을 안내하세요.
- 따뜻하고 안심시키는 상담 톤을 유지하되 과장하지 마세요.
- 답변은 3~6문장으로 간결하게. 필요 시 불릿으로 정리하세요.
- 측정값은 단위(mm/도)와 함께 제시하세요.`;

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
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
  if (normalized.patientContext) normalized.patientContext = fixKoreanEncoding(normalized.patientContext);
  return normalized;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = normalizeBody(req.body);
    const { messages = [], model = 'gemini-2.5-flash', userId, patientContext = '' } = body;

    if (!messages.length) {
      return res.status(400).json({ error: 'messages가 비어있습니다.' });
    }

    if (!isAzureChatConfigured() && !GEMINI_API_KEY) {
      return res.status(200).json({
        reply: '죄송합니다. AI 서비스 키가 설정되지 않아 답변을 생성할 수 없습니다. (Azure OpenAI 또는 GEMINI_API_KEY 필요)',
        sources: [],
        usage: { model: 'fallback' },
        fallback: true
      });
    }

    const userQuery = messages[messages.length - 1]?.content || '';

    // RAG 검색 — 김용을 원장 자료 포함 지식베이스에서 상위 4건
    let sources = [];
    try {
      sources = await searchKnowledge(userQuery, 4);
    } catch (e) {
      console.warn('[consult] RAG 건너뜀:', e.message);
    }

    const ragContext = sources.length
      ? `\n\n[참고 지식 — 김용을 원장 자료 및 임상 근거]\n${sources
          .map((s, i) => `[${i + 1}] (출처: ${s.source || '내부 자료'})\n${s.content}`)
          .join('\n\n')}`
      : '';

    const patientBlock = patientContext
      ? `\n\n[환자 정보]\n${patientContext}`
      : '';

    const fullSystem = SYSTEM_PROMPT + patientBlock + ragContext;

    // ---- Azure OpenAI 우선 ----
    if (isAzureChatConfigured()) {
      const azureMessages = messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));
      const reply = await azureChatCompletion({
        system: fullSystem,
        messages: azureMessages,
        temperature: 0.3,
        timeoutMs: 30000
      });

      if (userId) {
        try { await saveConversation(userId, [...messages, { role: 'assistant', content: reply }]); }
        catch (e) { console.warn('[consult] 저장 실패:', e.message); }
      }

      return res.status(200).json({
        reply,
        sources: sources.map(s => ({ source: s.source, snippet: (s.content || '').slice(0, 220) })),
        usage: { provider: 'azure-openai', model: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT }
      });
    }

    // ---- Gemini 폴백 ----
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const geminiModel = genAI.getGenerativeModel({ model, systemInstruction: fullSystem });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const chat = geminiModel.startChat({ history });
    const result = await chat.sendMessage(userQuery);
    const reply = result.response.text();

    if (userId) {
      try { await saveConversation(userId, [...messages, { role: 'assistant', content: reply }]); }
      catch (e) { console.warn('[consult] 대화 저장 실패:', e.message); }
    }

    return res.status(200).json({
      reply,
      sources: sources.map(s => ({ source: s.source, snippet: (s.content || '').slice(0, 220) })),
      usage: { model }
    });
  } catch (e) {
    console.error('[consult] 처리 실패:', e);
    return res.status(500).json({ error: e.message || '내부 서버 오류' });
  }
}
