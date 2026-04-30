import { GoogleGenerativeAI } from '@google/generative-ai';
import { saveDiagnosis } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const PROMPTS = {
  extraction: `당신은 교정치과 발치 판단 AI입니다.
입력된 환자 데이터를 기반으로 발치/비발치 권장도(0-100), 권장 발치 치아(FDI 표기), 5가지 근거, 위험요소, 비발치 대안을 JSON으로 반환하세요.
반드시 다음 JSON 스키마를 준수:
{"score": number, "recommendation": "extract"|"non_extract"|"borderline", "teeth": [string], "reasoning": [string], "risks": [string], "alternatives": [string]}
어린이(17세 이하)는 성장 잠재력을 고려해 발치 보류 가중치를 적용합니다.`,

  growth: `당신은 교정치과 성장 예측 AI입니다.
입력된 환자(어린이) 데이터를 기반으로 잔여 성장량, 골성숙 단계, 권장 치료 시기, 5가지 근거를 JSON으로 반환하세요.
스키마:
{"score": number, "remainingGrowthCm": number, "skeletalStage": string, "recommendation": string, "reasoning": [string], "risks": [string], "alternatives": [string]}`,

  facial: `당신은 교정치과 안모 변화 시뮬레이션 AI입니다.
입력값을 기반으로 안모 변화 방향, 심미적 영향, 권장도(0-100), 5가지 근거를 JSON으로 반환하세요.
스키마:
{"score": number, "recommendation": string, "facialChange": {"profileShift": string, "lipPosition": string, "chinPosition": string}, "reasoning": [string], "risks": [string], "alternatives": [string]}`,

  recurrence: `당신은 교정치과 재발 예측 AI입니다.
입력값을 기반으로 1/3/5/10년 재발 확률, 위험 요인, 권장 보정 프로토콜을 JSON으로 반환하세요.
스키마:
{"score": number, "recommendation": string, "probabilities": {"y1": number, "y3": number, "y5": number, "y10": number}, "reasoning": [string], "risks": [string], "alternatives": [string]}`
};

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

function normalizeInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return inputs;
  const out = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = typeof v === 'string' ? fixKoreanEncoding(v) : v;
  }
  return out;
}

function fallbackResult(type, inputs) {
  const base = {
    score: 50,
    recommendation: 'borderline',
    reasoning: ['AI 호출 실패로 룰베이스 폴백을 사용했습니다.', '입력값 재확인을 권장합니다.'],
    risks: ['AI 분석 미수행'],
    alternatives: ['수동 분석 후 재시도']
  };
  if (type === 'extraction') {
    const crowding = Number(inputs?.crowding || 0);
    const score = Math.min(100, Math.max(0, crowding * 10));
    return { ...base, score, recommendation: crowding > 6 ? 'extract' : crowding > 3 ? 'borderline' : 'non_extract', teeth: crowding > 6 ? ['14', '24', '34', '44'] : [] };
  }
  if (type === 'recurrence') {
    return { ...base, probabilities: { y1: 0.05, y3: 0.15, y5: 0.25, y10: 0.4 } };
  }
  return base;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { type, patient = {}, inputs = {}, save = false } = req.body || {};

  if (!type || !PROMPTS[type]) {
    return res.status(400).json({ error: `유효하지 않은 진단 type: ${type}` });
  }

  const cleanPatient = normalizeInputs(patient);
  const cleanInputs = normalizeInputs(inputs);

  if (!GEMINI_API_KEY) {
    console.warn('[diagnose] GEMINI_API_KEY 미설정 → 폴백 사용');
    return res.status(200).json({ ...fallbackResult(type, cleanInputs), fallback: true });
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: PROMPTS[type],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    const userMsg = `환자: ${JSON.stringify(cleanPatient)}\n입력: ${JSON.stringify(cleanInputs)}\n\nJSON으로만 응답하세요.`;
    const result = await model.generateContent(userMsg);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn('[diagnose] JSON 파싱 실패, 폴백 사용:', text.slice(0, 200));
      parsed = fallbackResult(type, cleanInputs);
    }

    if (typeof parsed.score !== 'number') parsed.score = 50;
    if (!Array.isArray(parsed.reasoning)) parsed.reasoning = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    if (!Array.isArray(parsed.alternatives)) parsed.alternatives = [];

    if (save && cleanPatient?.id) {
      try {
        await saveDiagnosis({ patientId: cleanPatient.id, type, inputs: cleanInputs, result: parsed });
      } catch (e) {
        console.warn('[diagnose] 저장 실패:', e.message);
      }
    }

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('[diagnose] 실패:', e);
    return res.status(200).json({ ...fallbackResult(type, cleanInputs), fallback: true, error: e.message });
  }
}
