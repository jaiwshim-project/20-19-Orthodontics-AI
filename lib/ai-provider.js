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
