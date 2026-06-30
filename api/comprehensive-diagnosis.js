import { GoogleGenerativeAI } from '@google/generative-ai';
import { azureVisionCompletion, isAzureChatConfigured } from '../lib/ai-provider.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
};

const IMAGE_LABELS = {
  frontal: '[구강 정면 사진]',
  rightLateral: '[구강 우측 측면 사진]',
  leftLateral: '[구강 좌측 측면 사진]',
  upperOcclusal: '[상악 교합면 사진]',
  lowerOcclusal: '[하악 교합면 사진]',
  ceph: '[세팔로 엑스레이]',
  faceFront: '[안면 정면 사진]',
  faceSide: '[안면 측면 사진]',
  faceOpen: '[안면 정면 입술 오픈]',
  faceClose: '[안면 정면 입술 클로즈]',
  faceOblique: '[45도 안면 사진]',
  upper: '[상악 교합면 사진]',
  lower: '[하악 교합면 사진]',
  pm: '[PM 1:1 모델 사진]',
  other: '[기타 참고자료]'
};

const SYSTEM_INSTRUCTION = `당신은 교정 전문의를 보조하는 Orthodontics AI 종합 진단 엔진입니다.
절대 최종 진단자처럼 단정하지 말고, 사진 기반 1차 판독과 EZ/TZ 계측 보조 결과로 표현하세요.

입력 자료:
- 구강 내 5방향 사진: 정면, 우측 측면, 좌측 측면, 상악 교합면, 하악 교합면
- 세팔로 엑스레이
- 안면 사진: 정면, 측면, 45도, 미소 또는 입술 오픈/클로즈
- 선택적으로 사용자가 찍은 EZ/TZ 곡선 수치

반드시 다음 5가지를 JSON으로 반환하세요.
1. 클래스 분류: Class I, Class II, Class III 중 하나와 근거
2. EZ와 TZ 수치 비교: 입력된 계측값이 있으면 우선 사용하고, 없으면 사진 기반 추정값으로 표시
3. EZ 곡선과 TZ 곡선 해석: 곡선이 의미하는 현재 치열 위치와 안정 배열 목표 설명
4. 발치 여부 추천: non_extraction, borderline, extraction_review 중 하나
5. 치료 계획 추천: 단계별 계획과 주의점

Class I 학습 기준:
- A=초진, B=최종 자료에서 Class I은 골격 전후방 문제보다 crowding, rotation, arch form discrepancy, occlusal instability가 중심이었다.
- 최종 결과는 치아 배열 정리, 회전 감소, 상하악 arch coordination, canine/premolar 관계 안정화, overjet/overbite 안정화가 반복되었다.
- 따라서 Class I은 정상이라는 뜻이 아니라 TZ를 안정적인 EZ 안으로 재배열해야 하는 유형이다.

Class II 기준:
- 상악 전돌 또는 하악 후퇴, convex profile, overjet 증가, deep bite 경향, 입술 돌출/긴장 가능성을 중점 평가한다.

Class III 기준:
- 하악 전돌 또는 상악 열성, concave profile, 전치부 반대교합/crossbite, edge-to-edge, 성장기 악화 가능성을 중점 평가한다.

응답은 반드시 아래 스키마의 JSON 객체만 반환하세요.
{
  "classification": {
    "class": "Class I" | "Class II" | "Class III",
    "confidence": number,
    "evidence": string[],
    "differential": string
  },
  "ezTz": {
    "upper": { "ezMm": number | null, "tzMm": number | null, "differenceMm": number | null, "interpretation": string },
    "lower": { "ezMm": number | null, "tzMm": number | null, "differenceMm": number | null, "interpretation": string },
    "totalDifferenceMm": number | null,
    "source": "measured" | "estimated" | "insufficient"
  },
  "curveAnnotation": {
    "ezDescription": string,
    "tzDescription": string,
    "visualInstruction": string
  },
  "extraction": {
    "recommendation": "non_extraction" | "borderline" | "extraction_review",
    "label": string,
    "reasons": string[],
    "cautions": string[]
  },
  "treatmentPlan": {
    "summary": string,
    "steps": string[],
    "doctorReviewPoints": string[]
  },
  "limitations": string[]
}`;

function clampNumber(value, min, max) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function normalizeImages(images = {}) {
  const out = [];
  for (const [key, image] of Object.entries(images || {})) {
    if (!image?.base64) continue;
    out.push({
      key,
      label: IMAGE_LABELS[key] || `[${key}]`,
      base64: image.base64,
      contentType: image.contentType || 'image/jpeg'
    });
  }
  return out;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function getDiscrepancy(ezTz = {}) {
  const values = [ezTz?.upper?.differenceMm, ezTz?.lower?.differenceMm].map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return Math.max(...values, values.reduce((a, b) => a + b, 0) / values.length);
}

function fallbackDiagnosis(body = {}, images = []) {
  const ezTz = body.ezTz || {};
  const upperDiff = round(ezTz?.upper?.differenceMm);
  const lowerDiff = round(ezTz?.lower?.differenceMm);
  const summed = [upperDiff, lowerDiff].filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const total = round(ezTz?.totalDiscrepancyMm ?? (summed || null));
  const basis = getDiscrepancy(ezTz);
  const hasCeph = images.some(i => i.key === 'ceph');
  const hasFace = images.some(i => ['faceFront', 'faceSide', 'faceOpen', 'faceClose', 'faceOblique'].includes(i.key));
  const hasFive = ['frontal', 'rightLateral', 'leftLateral', 'upperOcclusal', 'lowerOcclusal'].filter(k => images.some(i => i.key === k)).length >= 4;

  let recommendation = 'borderline';
  let label = '경계 케이스: 전문의 검토 필요';
  if (Number.isFinite(basis) && basis <= 2) {
    recommendation = 'non_extraction';
    label = '비발치 우선 검토';
  } else if (Number.isFinite(basis) && basis > 6) {
    recommendation = 'extraction_review';
    label = '발치 또는 적극적 공간 확보 검토';
  }

  return {
    classification: {
      class: 'Class I',
      confidence: hasFive && hasCeph && hasFace ? 0.62 : 0.45,
      evidence: [
        'AI 영상 판독을 사용할 수 없을 때는 Class I 학습 기준과 EZ/TZ 계측값을 우선 적용합니다.',
        'Class I은 골격 전후방 문제보다 crowding, rotation, arch form, occlusal stability 평가가 중심입니다.'
      ],
      differential: '세팔로 ANB, 안면 profile, overjet/crossbite 확인 후 Class II/III 가능성을 배제해야 합니다.'
    },
    ezTz: {
      upper: {
        ezMm: round(ezTz?.upper?.ezLengthMm),
        tzMm: round(ezTz?.upper?.tzLengthMm),
        differenceMm: upperDiff,
        interpretation: upperDiff == null ? '상악 EZ/TZ 곡선 계측이 필요합니다.' : `상악 TZ가 EZ보다 ${upperDiff} mm 큽니다.`
      },
      lower: {
        ezMm: round(ezTz?.lower?.ezLengthMm),
        tzMm: round(ezTz?.lower?.tzLengthMm),
        differenceMm: lowerDiff,
        interpretation: lowerDiff == null ? '하악 EZ/TZ 곡선 계측이 필요합니다.' : `하악 TZ가 EZ보다 ${lowerDiff} mm 큽니다.`
      },
      totalDifferenceMm: total,
      source: upperDiff != null || lowerDiff != null ? 'measured' : 'insufficient'
    },
    curveAnnotation: {
      ezDescription: 'EZ는 치아가 장기적으로 안정되게 배열될 목표 악궁 곡선입니다.',
      tzDescription: 'TZ는 현재 치아 배열이 만드는 실제 치열 곡선입니다.',
      visualInstruction: '캔버스에서 TZ는 현재 치열 중심을, EZ는 목표 안정 악궁선을 따라 찍어 두 곡선 차이를 확인하세요.'
    },
    extraction: {
      recommendation,
      label,
      reasons: [
        Number.isFinite(basis) ? `EZ/TZ 차이 기준값은 약 ${round(basis)} mm입니다.` : 'EZ/TZ 계측값이 부족해 보수적으로 경계 판정을 제시합니다.',
        '안모 돌출, 전치 경사, 치조골 한계가 있으면 발치 쪽으로 보정해야 합니다.'
      ],
      cautions: ['최종 발치 여부는 세팔로 계측, STL/PM 계측, 전문의 판단으로 확정해야 합니다.']
    },
    treatmentPlan: {
      summary: '사진 업로드와 EZ/TZ 계측을 바탕으로 한 1차 치료 방향입니다.',
      steps: [
        'Class I/II/III 감별을 위해 구강 5방향, 세팔로, 안면 profile을 함께 확인합니다.',
        '상악/하악 교합면에서 TZ와 EZ 곡선을 표시하고 공간 부족량을 계산합니다.',
        '경도 차이는 alignment, leveling, IPR 또는 제한적 확장을 우선 검토합니다.',
        '중등도 이상 차이는 발치/비발치 경계 분석과 안모 변화 예측을 함께 진행합니다.',
        '최종 목표는 치아를 EZ 안에 배열하고 안정적인 overjet, overbite, 구치부 교합을 확보하는 것입니다.'
      ],
      doctorReviewPoints: ['ANB/FMA/IMPA', '입술 돌출과 E-line', '치조골 한계', '성장 가능성', '유지장치와 재발 위험']
    },
    limitations: ['AI 미설정 또는 분석 실패 시 제공되는 규칙 기반 결과입니다.', '사진만으로는 mm 단위 확정 진단이 불가능합니다.']
  };
}

function sanitizeResult(parsed, body, images) {
  const fallback = fallbackDiagnosis(body, images);
  const result = { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  const allowedClasses = ['Class I', 'Class II', 'Class III'];
  const allowedExtraction = ['non_extraction', 'borderline', 'extraction_review'];

  result.classification = { ...fallback.classification, ...(result.classification || {}) };
  if (!allowedClasses.includes(result.classification.class)) result.classification.class = fallback.classification.class;
  result.classification.confidence = clampNumber(result.classification.confidence, 0, 1) ?? fallback.classification.confidence;
  result.classification.evidence = Array.isArray(result.classification.evidence) ? result.classification.evidence.slice(0, 6) : fallback.classification.evidence;

  result.ezTz = { ...fallback.ezTz, ...(result.ezTz || {}) };
  for (const arch of ['upper', 'lower']) {
    result.ezTz[arch] = { ...fallback.ezTz[arch], ...(result.ezTz[arch] || {}) };
    result.ezTz[arch].ezMm = round(result.ezTz[arch].ezMm);
    result.ezTz[arch].tzMm = round(result.ezTz[arch].tzMm);
    result.ezTz[arch].differenceMm = round(result.ezTz[arch].differenceMm);
  }
  result.ezTz.totalDifferenceMm = round(result.ezTz.totalDifferenceMm);

  result.curveAnnotation = { ...fallback.curveAnnotation, ...(result.curveAnnotation || {}) };
  result.extraction = { ...fallback.extraction, ...(result.extraction || {}) };
  if (!allowedExtraction.includes(result.extraction.recommendation)) result.extraction.recommendation = fallback.extraction.recommendation;
  result.extraction.reasons = Array.isArray(result.extraction.reasons) ? result.extraction.reasons.slice(0, 6) : fallback.extraction.reasons;
  result.extraction.cautions = Array.isArray(result.extraction.cautions) ? result.extraction.cautions.slice(0, 4) : fallback.extraction.cautions;

  result.treatmentPlan = { ...fallback.treatmentPlan, ...(result.treatmentPlan || {}) };
  result.treatmentPlan.steps = Array.isArray(result.treatmentPlan.steps) ? result.treatmentPlan.steps.slice(0, 8) : fallback.treatmentPlan.steps;
  result.treatmentPlan.doctorReviewPoints = Array.isArray(result.treatmentPlan.doctorReviewPoints) ? result.treatmentPlan.doctorReviewPoints.slice(0, 8) : fallback.treatmentPlan.doctorReviewPoints;
  result.limitations = Array.isArray(result.limitations) ? result.limitations.slice(0, 6) : fallback.limitations;
  return result;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};
  const images = normalizeImages(body.images || {});
  if (!images.length && !body.ezTz) {
    return res.status(400).json({ error: '최소 1장의 사진 또는 EZ/TZ 계측값이 필요합니다.' });
  }

  const totalBytes = images.reduce((sum, image) => sum + image.base64.length, 0);
  if (totalBytes > 45 * 1024 * 1024 * 1.4) {
    return res.status(413).json({ error: '이미지 합계가 너무 큽니다. 45MB 이내로 줄여주세요.' });
  }

  if (!isAzureChatConfigured() && !GEMINI_API_KEY) {
    return res.status(200).json({ ...fallbackDiagnosis(body, images), fallback: true, usedImages: images.map(i => i.key) });
  }

  try {
    const caseContext = JSON.stringify({
      patient: body.patient || {},
      ezTz: body.ezTz || null,
      modifiers: body.modifiers || {},
      uploadedImageKeys: images.map(i => i.key)
    });

    let text;
    if (isAzureChatConfigured()) {
      text = await azureVisionCompletion({
        system: SYSTEM_INSTRUCTION,
        images,
        prompt: `다음 케이스 컨텍스트와 이미지를 종합 분석하세요. JSON만 반환하세요.\n${caseContext}`,
        responseFormat: 'json',
        temperature: 0.15,
        timeoutMs: 45000
      });
    } else {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: SYSTEM_INSTRUCTION,
        generationConfig: { responseMimeType: 'application/json', temperature: 0.15 }
      });
      const parts = images.flatMap(image => ([
        { text: image.label },
        { inlineData: { data: image.base64, mimeType: image.contentType } }
      ]));
      parts.push({ text: `케이스 컨텍스트:\n${caseContext}\nJSON만 반환하세요.` });
      const result = await model.generateContent(parts);
      text = result.response.text();
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.warn('[comprehensive-diagnosis] JSON parse failed:', text?.slice?.(0, 300));
      return res.status(200).json({ ...fallbackDiagnosis(body, images), fallback: true, parseError: true, usedImages: images.map(i => i.key) });
    }

    return res.status(200).json({ ...sanitizeResult(parsed, body, images), fallback: false, usedImages: images.map(i => i.key) });
  } catch (error) {
    console.error('[comprehensive-diagnosis] failed:', error);
    return res.status(200).json({ ...fallbackDiagnosis(body, images), fallback: true, error: error.message, usedImages: images.map(i => i.key) });
  }
}
