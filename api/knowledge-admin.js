import { getAdmin } from '../lib/supabase.js';
import { embed, embedBatch } from '../lib/embeddings.js';
import { safeErrorMessage } from '../lib/safe-error.js';

// ============================================================
// 김용을 원장 자료 RAG 지식베이스 관리 API
//   - action: 'list'   → 저장된 지식 청크 조회
//   - action: 'add'    → 원문 텍스트를 청크로 분할·임베딩·저장
//   - action: 'delete' → 특정 청크 삭제
// knowledge_chunks 테이블(pgvector) 재사용. metadata.author 로 출처 구분.
// ============================================================

const ADMIN_PASS = process.env.ADMIN_DASH_PASS || 'orthodontics-admin-2026';

function fixKoreanEncoding(text) {
  if (!text || typeof text !== 'string') return text;
  if (/[^\x00-\x7F]/.test(text) && !/[가-힣]/.test(text)) {
    try { return Buffer.from(text, 'latin1').toString('utf8'); } catch { return text; }
  }
  return text;
}

// 긴 원문을 문단/문장 단위로 안전하게 청크 분할 (기본 ~600자)
function chunkText(text, maxLen = 600) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (clean.length <= maxLen) return [clean];

  // 우선 빈 줄(문단) 기준, 그다음 문장 기준으로 병합
  const paragraphs = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';

  const pushBuf = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const para of paragraphs) {
    if (para.length > maxLen) {
      // 문장 단위 분할
      const sentences = para.split(/(?<=[.!?。])\s+|(?<=다\.)\s*/).filter(Boolean);
      for (const s of sentences) {
        if ((buf + ' ' + s).trim().length > maxLen) pushBuf();
        buf = (buf ? buf + ' ' : '') + s;
      }
      pushBuf();
    } else {
      if ((buf + '\n\n' + para).length > maxLen) pushBuf();
      buf = (buf ? buf + '\n\n' : '') + para;
    }
  }
  pushBuf();
  return chunks.length ? chunks : [clean.slice(0, maxLen)];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};
  const action = body.action || 'list';

  let sb;
  try {
    sb = getAdmin();
  } catch (e) {
    return res.status(500).json({ error: 'Supabase 미설정: ' + e.message });
  }

  // ---- 조회는 인증 없이 허용 (읽기 전용) ----
  if (action === 'list') {
    try {
      const { data, error } = await sb
        .from('knowledge_chunks')
        .select('id, source, content, metadata, created_at')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return res.status(200).json({
        chunks: (data || []).map(c => ({
          id: c.id,
          source: c.source,
          content: c.content,
          author: c.metadata?.author || null,
          topic: c.metadata?.topic || null,
          created_at: c.created_at
        })),
        total: (data || []).length
      });
    } catch (e) {
      return res.status(500).json({ error: safeErrorMessage(e) });
    }
  }

  // ---- 쓰기 작업은 관리자 비밀번호 필요 ----
  if (body.adminPass !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized — adminPass가 필요합니다.' });
  }

  if (action === 'add') {
    const source = fixKoreanEncoding((body.source || '김용을 원장 자료').trim());
    const rawText = fixKoreanEncoding((body.content || '').trim());
    const author = fixKoreanEncoding((body.author || '김용을').trim());
    const topic = fixKoreanEncoding((body.topic || 'general').trim());

    if (!rawText) return res.status(400).json({ error: 'content(원문 텍스트)가 필요합니다.' });

    try {
      const chunks = chunkText(rawText);
      // 임베딩 시도 (프로바이더 불가 시 전부 null) → null이어도 저장(키워드 RAG 폴백)
      let vectors = new Array(chunks.length).fill(null);
      try {
        vectors = await embedBatch(chunks);
      } catch (e) {
        console.warn('[knowledge-admin] 임베딩 배치 실패(키워드검색용 저장):', e.message);
      }
      let embedded = 0;
      const rows = chunks.map((c, i) => {
        if (vectors[i]) embedded++;
        return {
          source: chunks.length > 1 ? `${source} (${i + 1}/${chunks.length})` : source,
          content: c,
          embedding: vectors[i] || null,
          metadata: { author, topic, ingested_via: 'knowledge-admin' }
        };
      });

      const { error } = await sb.from('knowledge_chunks').insert(rows);
      if (error) throw error;

      return res.status(200).json({
        inserted: rows.length,
        chunks: chunks.length,
        embedded,
        without_embedding: rows.length - embedded,
        source,
        author,
        note: embedded < rows.length
          ? '임베딩 미생성분은 키워드 검색으로 동작합니다.'
          : undefined
      });
    } catch (e) {
      console.error('[knowledge-admin] add 실패:', e.message);
      return res.status(500).json({ error: safeErrorMessage(e) });
    }
  }

  if (action === 'delete') {
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
    try {
      const { error } = await sb.from('knowledge_chunks').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: safeErrorMessage(e) });
    }
  }

  return res.status(400).json({ error: `알 수 없는 action: ${action}` });
}
