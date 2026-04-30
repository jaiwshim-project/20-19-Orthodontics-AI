import { GoogleGenerativeAI } from '@google/generative-ai';
import { saveDiagnosis } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const KO_RULE = `
중요: 모든 문자열 필드(reasoning, risks, alternatives, recommendation, notes 등)는 반드시 한국어로 작성하세요.
의학 전문 용어는 영문 병기 가능 (예: "치열궁 길이(arch length)").
숫자 필드와 enum 값(extract/non_extract/borderline 등)은 영문 그대로 유지.`;

const PROMPTS = {
  extraction: `당신은 교정치과 발치 판단 AI(TSC-2)입니다.
Tweed-Steiner-Down 룰에 더해 김용은 박사의 EZL/TTL 균형 이론과 Buccinator Mechanism을 통합 적용하세요.

핵심 분석 축:
1) 골격 분석 (ANB, FMA, IMPA) — Tweed/Steiner
2) 치아 분석 (Crowding, Overjet, Overbite, Profile, LipStrain)
3) EZL/TTL 균형 (김용은 박사 이론):
   - EZL = Equilibrium Zone Length (혀↔입술/뺨 압력 균형 치열궁 길이)
   - TTL = Total Teeth Length (12치아 폭 합)
   - EZL - TTL > 1.5mm: 스페이싱 (발치 X, 공간 폐쇄)
   - EZL - TTL < -1.5mm: 양측 발치 강력 시사
   - 균형: -1.5 ~ +1.5mm
4) Natural Healing 옵션 (40명 코호트 검증): 발치 후 5-16개월 관찰 시 평균 arch -6mm, overbite +2.8mm 자연 정렬

JSON 스키마:
{"score": number, "recommendation": "extract"|"non_extract"|"borderline"|"natural_healing", "teeth": [string], "reasoning": [string], "risks": [string], "alternatives": [string], "ezlAnalysis": {"upperBalance": number, "lowerBalance": number, "interpretation": string}}

어린이(17세 이하): 성장 잠재력 고려해 발치 보류 가중치 적용.${KO_RULE}`,

  growth: `당신은 교정치과 성장 예측 AI입니다.
입력된 환자(어린이) 데이터를 기반으로 잔여 성장량, 골성숙 단계, 권장 치료 시기, 5가지 근거를 JSON으로 반환하세요.
스키마:
{"score": number, "remainingGrowthCm": number, "skeletalStage": string, "recommendation": string, "reasoning": [string], "risks": [string], "alternatives": [string]}${KO_RULE}`,

  facial: `당신은 교정치과 안모 변화 시뮬레이션 AI입니다.
입력값을 기반으로 안모 변화 방향, 심미적 영향, 권장도(0-100), 5가지 근거를 JSON으로 반환하세요.
스키마:
{"score": number, "recommendation": string, "facialChange": {"profileShift": string, "lipPosition": string, "chinPosition": string}, "reasoning": [string], "risks": [string], "alternatives": [string]}${KO_RULE}`,

  recurrence: `당신은 교정치과 재발 예측 AI입니다.
입력값을 기반으로 1/3/5/10년 재발 확률, 위험 요인, 권장 보정 프로토콜을 JSON으로 반환하세요.
스키마:
{"score": number, "recommendation": string, "probabilities": {"y1": number, "y3": number, "y5": number, "y10": number}, "reasoning": [string], "risks": [string], "alternatives": [string]}${KO_RULE}`
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
    // 0-100 스케일로 통일 (프론트엔드와 일치)
    return { ...base, probabilities: { y1: 5, y3: 15, y5: 25, y10: 40 } };
  }
  if (type === 'growth') {
    return { ...base, remainingGrowthCm: 0, skeletalStage: 'unknown', recommendation: 'CVMS 재평가 필요' };
  }
  if (type === 'facial') {
    return { ...base, facialChange: { profileShift: 'minimal', lipPosition: 'unchanged', chinPosition: 'unchanged' } };
  }
  return base;
}

function clampScore(n, lo = 0, hi = 100) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 50;
  return Math.min(hi, Math.max(lo, v));
}

function normalizeProbabilities(p) {
  if (!p || typeof p !== 'object') return { y1: 5, y3: 15, y5: 25, y10: 40 };
  // Gemini가 0-1 스케일로 반환하면 100배. 0-100이면 그대로.
  const maxVal = Math.max(p.y1 || 0, p.y3 || 0, p.y5 || 0, p.y10 || 0);
  const factor = maxVal <= 1 ? 100 : 1;
  return {
    y1: clampScore((p.y1 || 0) * factor),
    y3: clampScore((p.y3 || 0) * factor),
    y5: clampScore((p.y5 || 0) * factor),
    y10: clampScore((p.y10 || 0) * factor)
  };
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
      model: 'gemini-2.5-flash-lite',
      systemInstruction: PROMPTS[type],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    const userMsg = `환자: ${JSON.stringify(cleanPatient)}\n입력: ${JSON.stringify(cleanInputs)}\n\nJSON으로만 응답하세요.`;
    // 30초 timeout으로 Gemini 응답 보호
    const result = await Promise.race([
      model.generateContent(userMsg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout 30s')), 30000))
    ]);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn('[diagnose] JSON 파싱 실패, 폴백 사용:', text.slice(0, 200));
      parsed = fallbackResult(type, cleanInputs);
    }

    parsed.score = clampScore(parsed.score);
    if (!Array.isArray(parsed.reasoning)) parsed.reasoning = [];
    if (!Array.isArray(parsed.risks)) parsed.risks = [];
    if (!Array.isArray(parsed.alternatives)) parsed.alternatives = [];
    if (type === 'recurrence') parsed.probabilities = normalizeProbabilities(parsed.probabilities);
    if (type === 'growth' && typeof parsed.remainingGrowthCm !== 'number') parsed.remainingGrowthCm = 0;

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
