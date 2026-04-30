import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAdmin } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 교정치과 환자 상담 전용 AI 카피라이터입니다.
4가지 AI 진단 결과를 환자에게 친화적인 1문단(150-250자) 한국어로 요약하세요.
의학 전문 용어는 괄호 안에 쉬운 설명을 곁들이고 (예: "발치 (작은 어금니 빼기)"), 환자가 동의를 결정하는 데 도움이 되도록 명확하고 따뜻한 톤으로.

JSON 스키마:
{
  "headline": "한 문장 요약 (50자 이내)",
  "summary": "환자 친화 1문단 (150-250자)",
  "before_state": "현재 상태 1줄 (60자 이내)",
  "after_state": "치료 후 예상 1줄 (60자 이내)",
  "duration_estimate": "예상 치료 기간 (예: 18-24개월)",
  "key_changes": [
    "변화 항목 1 (50자 이내)",
    "변화 항목 2",
    "변화 항목 3"
  ]
}`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { patientId } = req.body || {};
  if (!patientId) return res.status(400).json({ error: 'patientId 필수' });

  let patient = null;
  let diagnoses = [];
  try {
    const sb = getAdmin();
    const { data: pat } = await sb.from('patients').select('*').eq('id', patientId).single();
    patient = pat;
    const { data: diags } = await sb.from('diagnoses').select('*').eq('patient_id', patientId).order('created_at', { ascending: false });
    diagnoses = diags || [];
  } catch (e) {
    return res.status(500).json({ error: 'DB 조회 실패: ' + e.message });
  }

  if (diagnoses.length === 0) {
    return res.status(400).json({ error: '저장된 진단이 없습니다. 4 AI 진단 중 하나 이상 실행 후 저장해 주세요.' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(200).json({
      headline: '교정 치료 권장 사항',
      summary: 'AI 분석이 정상 작동하지 않아 수동 검토가 필요합니다.',
      before_state: '치료 전 상태',
      after_state: '치료 후 예상',
      duration_estimate: '18-24개월',
      key_changes: ['전반적 교합 개선', '안모 균형', '재발 예방'],
      fallback: true
    });
  }

  try {
    const ctx = { patient, diagnoses: {} };
    diagnoses.forEach(d => { ctx.diagnoses[d.type] = { score: d.result?.score, recommendation: d.result?.recommendation, reasoning: d.result?.reasoning }; });

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
    });

    const result = await Promise.race([
      model.generateContent(`환자 컨텍스트:\n${JSON.stringify(ctx, null, 2)}\n\n환자 친화 Before-After 요약을 JSON으로 작성하세요.`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout 30s')), 30000))
    ]);
    const text = result.response.text();

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { parsed = { headline: '교정 치료 권장 사항', summary: text.slice(0, 250), key_changes: [], fallback: true }; }

    parsed.patient_name = patient?.name;
    parsed.diagnosis_count = diagnoses.length;
    parsed.diagnoses_used = diagnoses.map(d => d.type);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(200).json({ error: e.message, fallback: true });
  }
}
