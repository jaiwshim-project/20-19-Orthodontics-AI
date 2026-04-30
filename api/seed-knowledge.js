import { getAdmin } from '../lib/supabase.js';
import { embed } from '../lib/embeddings.js';

const ADMIN_PASS = process.env.ADMIN_DASH_PASS || 'orthodontics-admin-2026';

const KNOWLEDGE_CHUNKS = [
  {
    source: 'Tweed CH 1946 — Frankfort-Mandibular Plane Angle',
    content: 'Tweed 분석은 FMA(Frankfort-Mandibular Plane Angle, 정상 25°±5)와 IMPA(하악 절치 각도, 정상 90°±5)를 기반으로 발치/비발치를 판단한다. FMA가 30° 이상이면 hyperdivergent(수직 성장형)으로 발치 권장, 20° 이하면 hypodivergent로 비발치가 안전하다. IMPA가 95° 초과 시 설측 경사 한계로 발치를 통한 정상화가 필요하다.',
    metadata: { engine: 'TSC-1', topic: 'extraction', year: 1946 }
  },
  {
    source: 'Steiner CC 1953 — Cephalometrics for you and me',
    content: 'Steiner 분석의 핵심은 SNA(상악 위치, 정상 82°±2), SNB(하악 위치, 정상 80°±2), ANB(상하악 관계, 정상 2°±2)다. ANB 4° 이상은 골격성 II급(상악 전돌), 0° 이하는 III급(하악 전돌)을 시사한다. 발치 결정의 일차 기준이며 수술 적응증 판단의 출발점이다.',
    metadata: { engine: 'TSC-1', topic: 'extraction', year: 1953 }
  },
  {
    source: 'Proffit WR 2018 — Contemporary Orthodontics 6th ed',
    content: 'Crowding(치열궁 부족) 분류 — 4mm 미만: 경미(IPR/확장으로 해결 가능), 4-8mm: 중등도(발치 vs IPR 결정), 8mm 초과: 심함(발치 강력 권장). 어린이의 경우 성장 잠재력으로 인해 같은 mm에서도 비발치 우선 검토하며 mid-parental height와 CVMS 단계를 함께 고려한다.',
    metadata: { engine: 'TSC-1', topic: 'crowding', year: 2018 }
  },
  {
    source: 'Baccetti T 2005 — Cervical Vertebral Maturation',
    content: 'CVMS(Cervical Vertebral Maturation Stage)는 측면 두부방사선의 C2-C4 경추 형태로 골 성숙 단계를 1-6으로 분류한다. CS1: 가속 전(8-9세), CS2: 가속 시작(9-10세), CS3: peak velocity ★(골격 치료 골든타임), CS4: peak 직후(12-13세), CS5: 감속(14-15세), CS6: 성장 완료(16세 이상). 손목 X-ray 없이도 측정 가능해 임상에서 가장 널리 사용된다.',
    metadata: { engine: 'CMG-1', topic: 'growth', year: 2005 }
  },
  {
    source: 'Tanner JM 1976 — Mid-parental height prediction',
    content: 'Mid-parental target height 계산법: 남아 = (아버지 + 어머니 + 13) / 2, 여아 = (아버지 + 어머니 - 13) / 2. 13cm는 평균 성별간 신장 차이를 반영한 보정값. 자녀의 유전적 성장 잠재력을 ±10cm 범위로 추정하며, CVMS 단계와 함께 잔여 성장량 예측에 활용된다.',
    metadata: { engine: 'CMG-1', topic: 'growth', year: 1976 }
  },
  {
    source: 'Ricketts RM 1968 — E-line esthetic principle',
    content: 'Ricketts E-line은 코끝(Pn)과 턱끝(Pog)을 잇는 측면 안모의 미적 기준선이다. 이상적 위치는 상순 -4mm(E-line 후방), 하순 -2mm. 발치 후 전치부 후방 이동에 따른 입술 변화는 골격 변화량의 60-70% 수준이며 환자 상담 시 시각화하면 동의율이 크게 향상된다.',
    metadata: { engine: 'LPI-1', topic: 'facial', year: 1968 }
  },
  {
    source: 'Bolton WA 1958 — Tooth size discrepancy',
    content: 'Bolton 비율 — 전치부 비율(anterior ratio)은 하악 6전치 합/상악 6전치 합 × 100으로 정상 77.2±1.65, 전체 비율(overall)은 91.3±1.91. 전치부 비율이 정상 벗어나면 IPR(interproximal reduction) 또는 보철 보정이 필요하다. 클리어얼라이너 치료 시 더욱 중요해진다.',
    metadata: { engine: 'TSC-1', topic: 'measurement', year: 1958 }
  },
  {
    source: 'Andrews LF 1972 — Six keys to normal occlusion',
    content: 'Andrews의 정상 교합 6 keys — 1) 어금니 관계, 2) 치관 각도(angulation), 3) 치관 경사(inclination), 4) 회전 없음, 5) 인접면 접촉, 6) Curve of Spee 평탄. 모든 교정 치료의 종착점은 이 6 keys 충족이며, 안정성과 심미를 동시에 달성하는 표준이다.',
    metadata: { engine: 'TSC-1', topic: 'occlusion', year: 1972 }
  },
  {
    source: 'Little RM 1988 — Long-term post-retention assessment',
    content: '치료 후 10년 시점 평균 재발률은 약 25%(baseline). 하악 절치의 위치 변화가 1.5mm 이상이면 재발 위험이 급증한다. Bonded retainer는 가철식 대비 -10% 위험 감소 효과가 있고, dual retainer(고정+가철)는 -15%. 협조도 하 환자는 +18% 위험 증가하므로 Bonded가 강력 권장된다.',
    metadata: { engine: 'MFR-1', topic: 'recurrence', year: 1988 }
  },
  {
    source: 'Naraghi S 2010 — Third molar influence on incisor crowding',
    content: '제3대구치(사랑니) 매복 시 치료 후 재발 위험이 +8% 증가한다. 매복 사랑니가 전치부로 압력을 가해 정중부 crowding을 유도하기 때문. 교정 치료 종료 시점에 사랑니 발치 또는 보정 36개월 이상 연장이 권장된다. 협조도 좋은 환자는 평생 야간 retainer 착용을 안내한다.',
    metadata: { engine: 'MFR-1', topic: 'recurrence', year: 2010 }
  },
  {
    source: '한국치과교정학회 임상가이드 2020 — 어린이 교정 치료 시기',
    content: '어린이 교정 치료의 골든 타임은 CVMS 3단계(만 11-13세, peak velocity 시점)다. 이 시기에 Class II 환자는 Twin Block, Class III 환자는 Face mask/Chin cup으로 골격 변화를 유도하면 비발치 + 비수술로 해결 가능한 케이스가 많아진다. 만 17세 이하 어린이는 발치 보류 가중치 -25점 적용해 성장 우선 치료를 우선 검토한다.',
    metadata: { engine: 'CMG-1', topic: 'pediatric', year: 2020 }
  },
  {
    source: 'AAO 2019 — Class III treatment options',
    content: 'Class III 골격성 부정교합 치료 옵션: 1) 어린이(CS1-CS3): Face mask + RPE(rapid palatal expansion)로 상악 전방 견인 효과 큼. 2) 청소년(CS4-CS5): Chin cup으로 하악 후방 회전. 3) 성인: 양악 수술(LeFort I + BSSO)이 표준. 4) 경미한 성인 케이스: 발치 + 캐모플라쥬 가능하나 안모 개선 한계.',
    metadata: { engine: 'TSC-1', topic: 'class3', year: 2019 }
  },
  {
    source: 'Drobocky OB Smith RJ 1989 — Soft tissue change ratio',
    content: '교정 치료 시 골격-연조직 변화 비율: 상악 전치 1mm 후방 → 상순 0.6mm 후방(약 60%), 하악 전치 1mm 전방 → 하순 0.7mm 전방(70%), 턱(Pog) 1mm 전방 → 연조직 턱 0.7mm. 이 비율은 안모 시뮬레이션의 기본 공식이며, 환자별 ±20% 편차 있으므로 상담 시 보수적으로 안내한다.',
    metadata: { engine: 'LPI-1', topic: 'softtissue', year: 1989 }
  },
  {
    source: 'WFO 2021 — Clear aligner vs fixed appliance',
    content: '클리어얼라이너(Invisalign 등) vs 고정식(브라켓): 1) 심미성: 얼라이너 우세. 2) 복잡 케이스: 고정식 우세(extrusion, rotation 효과적). 3) 협조도: 얼라이너는 22h/일 착용 필요해 협조도 영향 큼. 4) 치료 기간: 평균적으로 얼라이너가 약간 길거나 비슷. 발치 케이스는 고정식 + TADs(미니스크류) 조합이 표준.',
    metadata: { engine: 'TSC-1', topic: 'appliance', year: 2021 }
  },
  {
    source: 'KSO 2022 — Retention protocol guideline',
    content: '한국치과교정학회 권장 retention 프로토콜: 1) 비발치 + 협조도 상: Essix 24개월 야간 → 평생 1주 2회. 2) 발치 + 협조도 중: Bonded 3-3 + Essix 야간 36개월. 3) 협조도 하 또는 심한 회전: Bonded 평생 + Essix 야간. 4) 사랑니 매복: 발치 후 retention 시작. 매년 정기 검진 권장.',
    metadata: { engine: 'MFR-1', topic: 'retention', year: 2022 }
  }
];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { adminPass, force } = req.body || {};
  if (adminPass !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized — adminPass 필요' });
  }

  let sb;
  try {
    sb = getAdmin();
  } catch (e) {
    return res.status(500).json({ error: 'Supabase 미설정: ' + e.message });
  }

  // 기존 데이터 카운트
  const { count: existing } = await sb
    .from('knowledge_chunks')
    .select('*', { count: 'exact', head: true });

  if (existing > 0 && !force) {
    return res.status(200).json({
      skipped: true,
      message: `이미 ${existing}건 존재. 강제 재시드는 force:true 옵션`,
      existing_count: existing
    });
  }

  // 기존 삭제 (force)
  if (force && existing > 0) {
    await sb.from('knowledge_chunks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }

  const results = { inserted: 0, errors: [] };

  for (const chunk of KNOWLEDGE_CHUNKS) {
    try {
      const embedVec = await embed(chunk.content);
      const { error } = await sb
        .from('knowledge_chunks')
        .insert({
          source: chunk.source,
          content: chunk.content,
          embedding: embedVec,
          metadata: chunk.metadata
        });
      if (error) throw error;
      results.inserted++;
    } catch (e) {
      console.error('[seed-knowledge]', chunk.source, e.message);
      results.errors.push({ source: chunk.source, error: e.message });
    }
  }

  return res.status(200).json({
    ...results,
    total: KNOWLEDGE_CHUNKS.length,
    bucket: 'knowledge_chunks'
  });
}
