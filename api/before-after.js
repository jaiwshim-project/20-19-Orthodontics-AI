import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAdmin } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 교정치과 환자 상담 전용 AI 카피라이터 + 임상 시뮬레이션 엔진입니다.
4가지 AI 진단 결과(Before)를 받아 발치+교정 치료 후 예상 After 측정값을 산출하고,
환자 친화 한국어 요약(150-250자)과 함께 JSON으로 반환하세요.

치료 단계 정의 (예시 — 실제는 케이스별 가변):
1) Phase 1 (발치 / 준비): 1-3개월
2) Phase 2 (정렬 + 공간 폐쇄 / 능동 치료): 14-20개월
3) Phase 3 (마무리 + 보정): 18-24개월

JSON 스키마:
{
  "headline": "한 문장 요약 (50자 이내)",
  "summary": "환자 친화 1문단 (150-250자)",
  "before_state": "현재 상태 1줄 (60자 이내)",
  "after_state": "치료 후 예상 1줄 (60자 이내)",
  "duration_estimate": "예상 총 기간 (예: 18-24개월)",
  "phases": [
    {"name": "발치 (Extraction)", "duration_months": 2, "summary": "..."},
    {"name": "정렬 + 공간 폐쇄 (Alignment & Space Closure)", "duration_months": 16, "summary": "..."},
    {"name": "마무리 + 보정 (Detailing & Retention)", "duration_months": 6, "summary": "..."}
  ],
  "measurements": {
    "before": {"anb": number, "crowding": number, "overjet": number, "overbite": number, "fma": number, "impa": number, "profile": "convex|straight|concave", "lipStrain": "none|mild|severe"},
    "after": {"anb": number, "crowding": number, "overjet": number, "overbite": number, "fma": number, "impa": number, "profile": "convex|straight|concave", "lipStrain": "none|mild|severe"}
  },
  "key_changes": [
    "변화 항목 1 (50자 이내)",
    "변화 항목 2",
    "변화 항목 3"
  ]
}

규칙:
- Before 값은 실제 입력 데이터에서 추출
- After 값은 임상 표준 정상화 목표 (ANB→2, Overjet→2.5, IMPA→90 등)로 산출
- Crowding은 발치 시 거의 0으로 수렴
- 보수적 수치 — 과도한 변화량 금지`;

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

  // Before 측정값을 실제 inputs에서 추출
  function extractBeforeFromInputs() {
    const ext = diagnoses.find(d => d.type === 'extraction')?.inputs || {};
    return {
      anb: ext.anb ?? null,
      crowding: ext.crowding ?? null,
      overjet: ext.overjet ?? null,
      overbite: ext.overbite ?? null,
      fma: ext.fma ?? null,
      impa: ext.impa ?? null,
      profile: ext.profile ?? null,
      lipStrain: ext.lipStrain ?? null
    };
  }

  // After 추정 (룰베이스 기본값)
  function estimateAfter(before) {
    const moveTowards = (cur, target, factor = 0.7) => cur != null ? +(cur + (target - cur) * factor).toFixed(1) : null;
    return {
      anb: moveTowards(before.anb, 2),
      crowding: before.crowding != null ? Math.max(0, +(before.crowding * 0.05).toFixed(1)) : null,
      overjet: moveTowards(before.overjet, 2.5),
      overbite: moveTowards(before.overbite, 2.5),
      fma: moveTowards(before.fma, 25, 0.4),
      impa: moveTowards(before.impa, 90, 0.6),
      profile: before.profile === 'convex' ? 'straight' : before.profile,
      lipStrain: before.lipStrain === 'severe' ? 'mild' : 'none'
    };
  }

  if (!GEMINI_API_KEY) {
    const before = extractBeforeFromInputs();
    return res.status(200).json({
      headline: '교정 치료 권장 사항',
      summary: 'AI 분석이 정상 작동하지 않아 룰베이스 추정값을 표시합니다.',
      before_state: '치료 전 상태',
      after_state: '치료 후 예상',
      duration_estimate: '18-24개월',
      phases: [
        { name: '발치 (Extraction)', duration_months: 2, summary: '치료 공간 확보' },
        { name: '정렬 + 공간 폐쇄', duration_months: 16, summary: '브라켓 + 와이어' },
        { name: '마무리 + 보정', duration_months: 6, summary: '교합 정밀 조정' }
      ],
      measurements: { before, after: estimateAfter(before) },
      key_changes: ['교합 정상화', '안모 균형 개선', '재발 예방'],
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

    // measurements 폴백: 실제 입력값에서 추출
    if (!parsed.measurements?.before || !parsed.measurements?.after) {
      const before = extractBeforeFromInputs();
      parsed.measurements = parsed.measurements || {};
      parsed.measurements.before = parsed.measurements.before || before;
      parsed.measurements.after = parsed.measurements.after || estimateAfter(parsed.measurements.before);
    }
    // phases 폴백
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) {
      parsed.phases = [
        { name: '발치 (Extraction)', duration_months: 2, summary: '치료 공간 확보' },
        { name: '정렬 + 공간 폐쇄', duration_months: 16, summary: '브라켓 + 와이어 단계 진행' },
        { name: '마무리 + 보정', duration_months: 6, summary: '교합 정밀 조정 + Retention' }
      ];
    }

    parsed.patient_name = patient?.name;
    parsed.diagnosis_count = diagnoses.length;
    parsed.diagnoses_used = diagnoses.map(d => d.type);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(200).json({ error: e.message, fallback: true });
  }
}
