// 클라이언트로 나가는 에러 메시지에서 비밀값을 지운다.
//
// ⚠️ 왜 필요한가 (2026-07-29 프로덕션 실측):
//   /api/chat 이 500과 함께 다음을 그대로 반환했다 —
//   "Consumer 'api_key:AIza...(전문)...' has been suspended"
//   Gemini·Azure·Anthropic SDK는 실패 응답 본문에 **요청에 쓴 키를 되돌려 주며**,
//   그것이 e.message 에 들어온다. `error: e.message` 는 23곳에 있었다.
//   따라서 호출부마다 고르는 게 아니라 나가는 경계 한 곳에서 막는다.

// 키 형태별 패턴. 접두사가 알려진 것은 접두사째로 지운다.
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_\-]{10,}/g, 'AIza***'],              // Google API key
  [/sk-ant-[0-9A-Za-z_\-]{10,}/g, 'sk-ant-***'],        // Anthropic
  [/sk-[0-9A-Za-z_\-]{20,}/g, 'sk-***'],                // OpenAI 계열
  [/eyJ[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{10,}\.[0-9A-Za-z_\-]{10,}/g, '<jwt>'], // JWT(Supabase 등)
  [/\bghp_[0-9A-Za-z]{20,}/g, 'ghp_***'],
];

// api_key:VALUE, "api-key": "VALUE", Bearer VALUE 처럼 라벨이 붙은 형태.
// 접두사를 모르는 Azure 키(순수 16진/base64 84자)가 여기서 걸린다.
const LABELED_SECRET = /((?:api[-_]?key|apikey|authorization|bearer|access[-_]?token|secret|password|passwd|pwd)["'\s:=]{1,6})([A-Za-z0-9_\-.~+/=]{12,})/gi;

// Azure 엔드포인트는 리소스명(=조직 식별자)을 노출한다.
const AZURE_ENDPOINT = /https:\/\/[a-z0-9-]+\.(openai\.azure\.com|cognitiveservices\.azure\.com)/gi;

// 환경변수에 실제로 들어있는 값은 형태를 몰라도 지운다(가장 확실한 방어).
const ENV_SECRET_KEYS = [
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'ADMIN_DASH_PASS',
];

export function scrubSecrets(input) {
  if (input == null) return input;
  let out = String(input);

  for (const name of ENV_SECRET_KEYS) {
    const value = process.env[name];
    // 8자 미만은 우연 일치로 멀쩡한 문장을 망칠 수 있어 건너뛴다.
    if (value && value.length >= 8) out = out.split(value).join(`<${name}>`);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(LABELED_SECRET, (_m, label) => `${label}***`);
  out = out.replace(AZURE_ENDPOINT, 'https://<azure-resource>.$1');
  return out;
}

/**
 * 에러를 클라이언트에 실어도 되는 문자열로 바꾼다.
 * 서버 로그에는 원본을 남겨야 하므로 console.error 는 호출부에서 따로 한다.
 */
export function safeErrorMessage(err, fallback = '내부 서버 오류') {
  const raw = (err && (err.message || err.error?.message)) || err;
  const scrubbed = scrubSecrets(raw);
  if (!scrubbed || typeof scrubbed !== 'string') return fallback;
  // 프로바이더 원본은 수천 자에 이르고 스택·URL이 섞인다. 앞부분만 준다.
  const trimmed = scrubbed.trim().slice(0, 300);
  return trimmed || fallback;
}
