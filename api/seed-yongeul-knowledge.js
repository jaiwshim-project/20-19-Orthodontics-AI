import { getAdmin } from '../lib/supabase.js';
import { embed } from '../lib/embeddings.js';

// ============================================================
// 김용을 원장 자료 시드 — 환자 상담 RAG 초기 지식
//   EZL/TTL 이론(Buccinator Mechanism)을 knowledge_chunks에 저장.
//   metadata.author = '김용을' 로 구분해 환자 상담 답변에서 우선 인용.
// ============================================================

const ADMIN_PASS = process.env.ADMIN_DASH_PASS || 'orthodontics-admin-2026';

const YONGEUL_CHUNKS = [
  {
    source: '김용을 원장 — Buccinator Mechanism 개론',
    content: '치아의 위치는 안쪽에서 미는 혀의 힘(약 5~10g)과 바깥쪽에서 미는 볼·입술의 힘이 균형을 이루는 지점에서 결정된다. 이 균형점을 따라 그린 곡선을 EZL(Equilibrium Zone Length, 균형존 길이)이라 하며, 치아가 가장 안정적으로 자리 잡을 수 있는 치열궁의 공간을 뜻한다. 이 원리를 Buccinator Mechanism(협근 메커니즘)이라 부른다.',
    metadata: { author: '김용을', topic: 'ezl-theory', engine: 'EZL-TTL' }
  },
  {
    source: '김용을 원장 — EZL과 TTL 정의',
    content: 'EZL(Equilibrium Zone Length)은 혀와 볼·입술 압력이 균형을 이루는 안정적인 치열궁의 길이로, 교합면 사진에서 노란색 곡선으로 표시한다. TTL(Total Tooth Length)은 실제 치아들의 폭(근원심 폭경)을 모두 더한 길이로, 빨간색 곡선으로 표시한다. 두 값을 비교하면 현재 치열에 공간이 부족한지 남는지를 판단할 수 있다.',
    metadata: { author: '김용을', topic: 'ezl-ttl-definition', engine: 'EZL-TTL' }
  },
  {
    source: '김용을 원장 — EZL/TTL 판정 기준',
    content: 'TTL과 EZL의 관계로 치열 상태를 판정한다. (1) TTL ≈ EZL: 치아와 공간이 잘 맞는 정상 배열. (2) TTL > EZL: 치아 폭의 합이 안정 공간보다 커서 자리가 부족함 → 치아가 겹치는 총생(Crowding)이 발생하며, 부족량이 크면 발치를 검토한다. (3) TTL < EZL: 공간이 남아 치아 사이에 틈(Spacing)이 생긴다. 발치 여부는 TTL−EZL 차이(mm)를 핵심 지표로 판단한다.',
    metadata: { author: '김용을', topic: 'ezl-ttl-diagnosis', engine: 'EZL-TTL' }
  },
  {
    source: '김용을 원장 — 곡선 작도법',
    content: 'EZL 곡선은 치아 바깥쪽(순측/협측)에서 양측 최후방 구치를 부드러운 U자 형태로 잇는다. TTL 곡선은 각 치아의 절단연 또는 교두정에서 가장 바깥쪽 접촉점을 순서대로 연결한다. 상악과 하악 교합면 사진 모두에 그려 상하악 균형을 함께 평가한다.',
    metadata: { author: '김용을', topic: 'curve-drawing', engine: 'EZL-TTL' }
  },
  {
    source: '김용을 원장 — 환자 상담 관점의 EZL/TTL',
    content: '환자에게 설명할 때는 EZL을 "치아가 편하게 들어갈 수 있는 잇몸의 공간", TTL을 "지금 치아들이 실제로 차지하는 공간"으로 비유하면 이해가 쉽다. 공간(EZL)보다 치아(TTL)가 크면 겹쳐서 삐뚤어지고, 이때 무리하게 치아를 벌리면 입이 튀어나오거나 재발 위험이 커지므로, 발치로 공간을 확보하는 것이 오히려 안정적일 수 있음을 안내한다. 최종 결정은 정밀 진단 후 원장과 상의한다.',
    metadata: { author: '김용을', topic: 'patient-counseling', engine: 'EZL-TTL' }
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

  // 김용을 자료 기존 존재 확인 (metadata.author 기준)
  const { data: existingRows } = await sb
    .from('knowledge_chunks')
    .select('id')
    .contains('metadata', { author: '김용을' });

  const existing = existingRows?.length || 0;

  if (existing > 0 && !force) {
    return res.status(200).json({
      skipped: true,
      message: `김용을 원장 자료 ${existing}건 이미 존재. 재시드는 force:true`,
      existing_count: existing
    });
  }

  if (force && existing > 0) {
    await sb.from('knowledge_chunks').delete().contains('metadata', { author: '김용을' });
  }

  const results = { inserted: 0, embedded: 0, without_embedding: 0, errors: [] };
  for (const chunk of YONGEUL_CHUNKS) {
    // 임베딩 시도 → 실패 시 null 임베딩으로라도 저장 (키워드 RAG 폴백이 검색 가능)
    let embedVec = null;
    try {
      embedVec = await embed(chunk.content);
    } catch (e) {
      console.warn('[seed-yongeul] 임베딩 실패(키워드검색용으로 저장):', chunk.source, e.message);
    }
    try {
      const { error } = await sb.from('knowledge_chunks').insert({
        source: chunk.source,
        content: chunk.content,
        embedding: embedVec,   // null 허용 — 임베딩 복구 후 재시드하면 벡터 검색 활성화
        metadata: chunk.metadata
      });
      if (error) throw error;
      results.inserted++;
      if (embedVec) results.embedded++; else results.without_embedding++;
    } catch (e) {
      console.error('[seed-yongeul]', chunk.source, e.message);
      results.errors.push({ source: chunk.source, error: e.message });
    }
  }

  return res.status(200).json({
    ...results,
    total: YONGEUL_CHUNKS.length,
    note: results.without_embedding > 0
      ? '임베딩 프로바이더 미가동 → 키워드 검색으로 동작. 키 복구 후 force:true 재시드 권장.'
      : undefined
  });
}
