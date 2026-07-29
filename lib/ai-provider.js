import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Claude 모델 3단 분리 (2026-07-29) ─────────────────────────────────
// ⚠️ 이전에는 4개 파일이 **같은 `ANTHROPIC_MODEL` 을 서로 다른 기본값**으로
//    읽었다(opus-4-8 / sonnet-4-6 / haiku-4-5). 환경변수를 하나 설정하면
//    4곳이 전부 그 모델로 덮어써져, haiku 로 충분한 계측까지 opus 로 돌았다.
//    작업 성격별로 변수를 나눠 그 사고를 구조적으로 막는다.
//   HEAVY  = 진단·상담·치료계획 (긴 추론)
//   VISION = 사진 분류·계측·랜드마크 (이미지 판독)
//   LIGHT  = 단순 판별·태깅
// `ANTHROPIC_MODEL` 은 세 변수 모두의 공통 오버라이드로 남긴다(하위 호환).
const ANTHROPIC_MODEL_OVERRIDE = process.env.ANTHROPIC_MODEL;
export const ANTHROPIC_MODEL_HEAVY =
  ANTHROPIC_MODEL_OVERRIDE || process.env.ANTHROPIC_MODEL_HEAVY || 'claude-opus-5';
// ⚠️ VISION 기본값은 실측으로 haiku 로 되돌렸다(2026-07-30). sonnet-5 를 쓰면
//    치아 폭을 개당 −17.8% 로 크게 과소추정한다(haiku −4.7%). 정답 55건 쌍대
//    비교에서 haiku 가 4개 지표 전부 압도(52~55:0~4, p≈0).
//    ⚠️ "sonnet 이 TTL 을 개선한다"는 중간 판정은 **허상**이었다 — 모델은 항상
//       14개를 반환하는데 정답 주석은 11~12개라, 개수 초과(+16.7% 상당)가
//       과소추정을 상쇄해 총합만 맞아 보였다. 근거: 03 AI 재학습/width_verdict.json
export const ANTHROPIC_MODEL_VISION =
  ANTHROPIC_MODEL_OVERRIDE || process.env.ANTHROPIC_MODEL_VISION
  || 'claude-haiku-4-5-20251001';
export const ANTHROPIC_MODEL_LIGHT =
  ANTHROPIC_MODEL_OVERRIDE || process.env.ANTHROPIC_MODEL_LIGHT || 'claude-haiku-4-5-20251001';

// 기존 호출부 호환: 모델을 지정하지 않으면 HEAVY 를 쓴다.
const ANTHROPIC_MODEL = ANTHROPIC_MODEL_HEAVY;

const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_CHAT_DEPLOYMENT = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
const AZURE_OPENAI_EMBEDDING_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
const AZURE_OPENAI_EMBEDDING_DIMENSIONS = Number(process.env.AZURE_OPENAI_EMBEDDING_DIMENSIONS || 768);

function trimSlash(value = '') {
  return value.replace(/\/+$/, '');
}

function assertAzureBase() {
  if (!AZURE_OPENAI_API_KEY) throw new Error('AZURE_OPENAI_API_KEY is not configured.');
  if (!AZURE_OPENAI_ENDPOINT) throw new Error('AZURE_OPENAI_ENDPOINT is not configured.');
}

function azureUrl(deployment, route) {
  assertAzureBase();
  if (!deployment) throw new Error('Azure OpenAI deployment name is not configured.');
  return `${trimSlash(AZURE_OPENAI_ENDPOINT)}/openai/deployments/${encodeURIComponent(deployment)}/${route}?api-version=${encodeURIComponent(AZURE_OPENAI_API_VERSION)}`;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      throw new Error(`Azure OpenAI request failed: ${message}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function isAnthropicConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

let _anthropicClient = null;
function getAnthropic() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  if (!_anthropicClient) _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _anthropicClient;
}

// Claude(Anthropic) 채팅 완성 — system + messages(user/assistant) → 텍스트 응답
export async function anthropicChatCompletion({
  system,
  messages,
  maxTokens = 2048,
  temperature,
  model = ANTHROPIC_MODEL_HEAVY,
  timeoutMs = 30000
}) {
  const client = getAnthropic();
  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: anthropicMessages
  };
  if (Number.isFinite(temperature)) params.temperature = temperature;

  let resp;
  try {
    resp = await client.messages.create(params, { timeout: timeoutMs });
  } catch (e) {
    // ⚠️ Claude 5 계열은 temperature 를 거부한다 — 실측:
    //    400 invalid_request_error "`temperature` is deprecated for this model."
    //    모델명 정규식으로 판별하면 미래 모델 ID에서 또 깨지므로, 그 에러일 때만
    //    파라미터를 떼고 한 번 재시도한다(모델 목록을 하드코딩하지 않는다).
    const isTempRejected = params.temperature !== undefined
      && /temperature/i.test(String(e?.message || ''))
      && /deprecat|unsupported|not support|invalid/i.test(String(e?.message || ''));
    if (!isTempRejected) throw e;
    delete params.temperature;
    resp = await client.messages.create(params, { timeout: timeoutMs });
  }

  const text = extractAnthropicText(resp);

  // ⚠️ 빈 텍스트 재시도 — 실측 16.7%(24회 중 4회) 발생하던 조용한 실패.
  //    sonnet/haiku 가 때때로 `thinking` 블록을 내보내는데, 그것이 max_tokens 를
  //    소진하면 text 블록이 0개가 되어 여기서 '' 가 나온다(stop_reason=max_tokens).
  //    호출부는 '' 를 파싱 실패로 처리해 폴백/500 을 반환했다 — 200 이 아니라
  //    사용자에게 "AI가 치아를 충분히 검출하지 못했습니다" 로 보였다.
  //    maxTokens 상향만으로는 확률만 낮아지고 0 이 되지 않으므로, 이 조건일 때
  //    한도를 늘려 한 번 더 시도한다.
  if (!text && resp?.stop_reason === 'max_tokens') {
    const retry = { ...params, max_tokens: Math.min(Math.max(maxTokens * 2, 4096), 16000) };
    const resp2 = await client.messages.create(retry, { timeout: timeoutMs });
    const text2 = extractAnthropicText(resp2);
    if (text2) return text2;
  }
  return text;
}

// Claude 응답에서 텍스트만 뽑는다. `thinking`/`redacted_thinking` 등 다른 블록
// 타입은 제외한다 — 그래서 thinking 만 온 응답은 '' 가 된다(위 재시도 참조).
function extractAnthropicText(resp) {
  return (resp?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
}

/**
 * Claude 비전 완성 — 이미지 + 프롬프트 → 텍스트.
 *
 * ⚠️ 이 함수가 lib 에 없어서 api/detect-arch-landmarks.js,
 *    api/classify-diagnosis.js, api/measure-tooth-widths.js 가 각자 같은 코드를
 *    중복 구현했고, 나머지 비전 엔드포인트 4개는 Claude 를 쓸 방법이 아예
 *    없었다(Azure/Gemini 만 보고 둘 다 죽어 폴백만 반환). 여기로 통합한다.
 *
 * Azure 와 이미지 형식이 다르다: Azure 는 `image_url` + data URL,
 * Claude 는 `image` + `source.{type,media_type,data}` 로 base64 를 직접 받는다.
 * responseFormat:'json' 은 Claude 에 대응 파라미터가 없어 무시된다
 * (호출부가 system 프롬프트로 JSON 을 요구하고 파싱한다).
 */
export async function anthropicVisionCompletion({
  system,
  prompt,
  images = [],
  maxTokens = 2600,
  temperature = 0.05,
  model = ANTHROPIC_MODEL_VISION,
  timeoutMs = 45000
}) {
  const content = [];
  for (const image of images) {
    if (image.label) content.push({ type: 'text', text: image.label });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.contentType || image.mimeType || 'image/jpeg',
        data: image.base64
      }
    });
  }
  if (prompt) content.push({ type: 'text', text: prompt });

  return anthropicChatCompletion({
    system,
    messages: [{ role: 'user', content }],
    maxTokens,
    temperature,
    model,
    timeoutMs
  });
}

export function isAzureChatConfigured() {
  return Boolean(AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_CHAT_DEPLOYMENT);
}

export function isAzureEmbeddingConfigured() {
  return Boolean(AZURE_OPENAI_API_KEY && AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_EMBEDDING_DEPLOYMENT);
}

export async function azureChatCompletion({
  system,
  messages,
  temperature = 0.2,
  responseFormat,
  timeoutMs = 30000
}) {
  const payloadMessages = [];
  if (system) payloadMessages.push({ role: 'system', content: system });
  payloadMessages.push(...messages);

  const body = {
    messages: payloadMessages,
    temperature
  };
  if (responseFormat === 'json') body.response_format = { type: 'json_object' };

  const data = await fetchJsonWithTimeout(
    azureUrl(AZURE_OPENAI_CHAT_DEPLOYMENT, 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify(body)
    },
    timeoutMs
  );

  return data.choices?.[0]?.message?.content || '';
}

export async function azureVisionCompletion({
  system,
  prompt,
  images,
  temperature = 0.2,
  responseFormat,
  timeoutMs = 30000
}) {
  const content = [];
  for (const image of images) {
    if (image.label) content.push({ type: 'text', text: image.label });
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.contentType || image.mimeType || 'image/jpeg'};base64,${image.base64}`
      }
    });
  }
  if (prompt) content.push({ type: 'text', text: prompt });

  return azureChatCompletion({
    system,
    messages: [{ role: 'user', content }],
    temperature,
    responseFormat,
    timeoutMs
  });
}

export async function azureEmbed(text) {
  const body = { input: text };
  if (Number.isFinite(AZURE_OPENAI_EMBEDDING_DIMENSIONS) && AZURE_OPENAI_EMBEDDING_DIMENSIONS > 0) {
    body.dimensions = AZURE_OPENAI_EMBEDDING_DIMENSIONS;
  }

  const data = await fetchJsonWithTimeout(
    azureUrl(AZURE_OPENAI_EMBEDDING_DEPLOYMENT, 'embeddings'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_API_KEY
      },
      body: JSON.stringify(body)
    },
    30000
  );

  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('Azure OpenAI embedding response did not include an embedding.');
  return embedding;
}
