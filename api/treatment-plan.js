import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAdmin } from '../lib/supabase.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 교정치과 마스터 오케스트레이터(TreatmentPlanner)입니다.
환자의 4가지 AI 진단 결과(발치/성장/안모/재발)를 종합해 단일 통합 치료 계획을 수립하세요.

원칙:
1. 단계별(phases) 치료 계획 작성 — 일반적으로 Phase 1(준비) → Phase 2(능동) → Phase 3(보정)
2. 각 단계마다: 기간, 목표, 사용 장치, 예상 결과
3. 4개 진단의 권장사항을 충돌 없이 통합 (예: 발치 권장 + 성장기면 → 성장 활용 후 발치 또는 비발치 우선)
4. 환자 연령군(child/adult) 고려
5. 안모 변화와 재발 위험을 보정 프로토콜에 반영

JSON 스키마 (한국어로 작성, 의학 용어는 영문 병기):
{
  "summary": string,                    // 전체 요약 1-2문장
  "approach": "extraction"|"non_extraction"|"two_phase"|"surgical"|"hybrid",
  "phases": [
    {
      "phase": number,
      "name": string,                   // "Phase 1 — 준비" 등
      "duration_months": number,
      "objectives": [string],           // 3-5개 목표
      "appliances": [string],           // 사용 장치
      "key_actions": [string],          // 주요 시술
      "expected_outcome": string
    }
  ],
  "total_duration_months": number,
  "estimated_cost_krw": {
    "min": number,                      // 최소 (KRW)
    "max": number                       // 최대
  },
  "key_decisions": [string],            // 결정적 임상 판단 5개
  "risk_summary": [string],             // 통합 위험 요인
  "patient_education": [string],        // 환자에게 설명할 핵심 사항
  "follow_up_schedule": string,         // "매 4주" 등
  "alternative_approaches": [string]    // 대안 접근법
}`;

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

function buildContext(patient, diagnoses) {
  const ctx = {
    patient: {
      name: patient?.name,
      age: patient?.age || patient?.metadata?.age,
      ageGroup: patient?.age_group || patient?.ageGroup,
      gender: patient?.gender,
      dob: patient?.dob
    },
    diagnoses: {}
  };
  diagnoses.forEach(d => {
    ctx.diagnoses[d.type] = {
      score: d.result?.score,
      recommendation: d.result?.recommendation,
      teeth: d.result?.teeth,
      reasoning: d.result?.reasoning,
      probabilities: d.result?.probabilities,
      remainingGrowthCm: d.result?.remainingGrowthCm,
      facialChange: d.result?.facialChange,
      inputs: d.inputs,
      created_at: d.created_at
    };
  });
  return ctx;
}

function fallbackPlan(patient, diagnoses) {
  const types = diagnoses.map(d => d.type);
  return {
    summary: 'AI 호출 실패로 자동 폴백 — 의사 직접 검토 권장',
    approach: 'non_extraction',
    phases: [
      { phase: 1, name: 'Phase 1 — 진단 보강', duration_months: 1, objectives: ['추가 검사', 'CBCT 검토'], appliances: [], key_actions: ['정밀 진단'], expected_outcome: '치료 방향 확정' },
      { phase: 2, name: 'Phase 2 — 능동 치료', duration_months: 18, objectives: ['교합 개선'], appliances: ['고정식 교정장치'], key_actions: ['Bracket 부착', 'Wire 단계 진행'], expected_outcome: '교합 안정' },
      { phase: 3, name: 'Phase 3 — 보정', duration_months: 24, objectives: ['장기 안정성'], appliances: ['Essix retainer'], key_actions: ['야간 착용'], expected_outcome: '재발 방지' }
    ],
    total_duration_months: 43,
    estimated_cost_krw: { min: 5000000, max: 8000000 },
    key_decisions: ['추가 정밀 진단 후 결정'],
    risk_summary: ['AI 분석 미수행', '직접 검증 필수'],
    patient_education: ['치료 기간', '협조도 중요성'],
    follow_up_schedule: '매 4-6주',
    alternative_approaches: ['단계적 진단 후 재계획'],
    fallback: true,
    diagnoses_used: types
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { patientId } = req.body || {};
  if (!patientId) return res.status(400).json({ error: 'patientId 필수' });

  let patient = null;
  let diagnoses = [];

  try {
    const sb = getAdmin();
    const { data: pat, error: patErr } = await sb
      .from('patients')
      .select('*')
      .eq('id', patientId)
      .single();
    if (patErr) throw patErr;
    patient = pat;

    const { data: diags, error: diagErr } = await sb
      .from('diagnoses')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false });
    if (diagErr) throw diagErr;
    diagnoses = diags || [];
  } catch (e) {
    console.error('[treatment-plan] DB 조회 실패:', e.message);
    return res.status(500).json({ error: '환자 정보 조회 실패: ' + e.message });
  }

  if (diagnoses.length === 0) {
    return res.status(400).json({ error: '저장된 진단이 없습니다. 먼저 4종 AI 진단 중 하나 이상을 실행하세요.' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(200).json(fallbackPlan(patient, diagnoses));
  }

  try {
    const ctx = buildContext(patient, diagnoses);
    const userMsg = `환자 컨텍스트:\n${JSON.stringify(ctx, null, 2)}\n\n위 4가지 AI 진단 결과를 종합해 단일 통합 치료 계획을 JSON으로 반환하세요.\n반드시 한국어로 작성하되 의학 용어는 영문 병기.`;

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
    });

    const result = await Promise.race([
      model.generateContent(userMsg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout 50s')), 50000))
    ]);
    const text = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn('[treatment-plan] JSON 파싱 실패:', text.slice(0, 200));
      return res.status(200).json(fallbackPlan(patient, diagnoses));
    }

    parsed.diagnoses_used = diagnoses.map(d => d.type);
    parsed.diagnosis_count = diagnoses.length;
    parsed.generated_at = new Date().toISOString();
    parsed.patient_name = patient?.name;

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('[treatment-plan] 실패:', e);
    return res.status(200).json({ ...fallbackPlan(patient, diagnoses), error: e.message });
  }
}
