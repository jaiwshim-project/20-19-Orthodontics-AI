# 텍스트 계열 엔드포인트 3개(diagnose / treatment-plan / before-after)에 Claude 경로 추가.
#
# 세 파일 구조가 동일하다: `if (!isAzureChatConfigured() && !GEMINI_API_KEY)` 가드 →
# `if (isAzureChatConfigured()) { azureChatCompletion(...) } else { Gemini }`.
# Claude 분기를 Azure **앞에** 끼운다(운영 환경에 ANTHROPIC_API_KEY 만 있다).
#
# ⚠️ Claude 에는 responseFormat:'json' 대응 파라미터가 없다 → system 프롬프트로 JSON
#    을 강제하고, 호출부의 JSON.parse 는 펜스를 허용하는 관대 파서로 바꾼다.
#    (그대로 두면 Claude 응답이 전부 폴백으로 떨어져 "동작하는데 결과가 룰베이스"가 된다.)
import io
import sys

sys.stdout.reconfigure(encoding='utf-8')

LOOSE_JSON_HELPER = '''// ⚠️ Azure/Gemini 는 JSON 모드가 있어 순수 JSON 이 오지만 Claude 는 없다 —
//    ```json 펜스나 앞뒤 설명이 섞일 수 있으므로 관대하게 추출한다.
function parseLooseJson(text) {
  const raw = String(text || '');
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

'''

# 파일별: (경로, system 상수명, maxTokens, timeoutMs, 헬퍼를 끼울 앵커)
TARGETS = [
    ('../../api/diagnose.js', 'PROMPTS[type]', 3000, 45000),
    ('../../api/treatment-plan.js', 'SYSTEM_PROMPT', 4000, 60000),
    ('../../api/before-after.js', 'SYSTEM_PROMPT', 3000, 45000),
]

OLD_IMPORT = ("import { azureChatCompletion, isAzureChatConfigured } "
              "from '../lib/ai-provider.js';")
NEW_IMPORT = """import {
  azureChatCompletion, isAzureChatConfigured,
  anthropicChatCompletion, isAnthropicConfigured, ANTHROPIC_MODEL_HEAVY
} from '../lib/ai-provider.js';"""


def patch(path, system_expr, max_tokens, timeout_ms):
    text = io.open(path, encoding='utf-8').read()
    n = 0

    assert text.count(OLD_IMPORT) == 1, ('import 앵커', path)
    text = text.replace(OLD_IMPORT, NEW_IMPORT, 1)
    n += 1

    guard_old = 'if (!isAzureChatConfigured() && !GEMINI_API_KEY) {'
    assert text.count(guard_old) == 1, ('가드 앵커', path)
    text = text.replace(
        guard_old,
        'if (!isAnthropicConfigured() && !isAzureChatConfigured() && !GEMINI_API_KEY) {',
        1)
    n += 1

    branch_old = """    if (isAzureChatConfigured()) {
      text = await azureChatCompletion({"""
    branch_new = """    if (isAnthropicConfigured()) {
      // 진단·치료계획·상담 요약은 긴 추론 → HEAVY.
      // ⚠️ Claude 에는 responseFormat:'json' 이 없다 → system 으로 JSON 을 강제한다.
      text = await anthropicChatCompletion({
        system: `${%s}\\n\\nRespond with valid JSON only. No prose, no markdown fences.`,
        messages: [{ role: 'user', content: userMsg }],
        model: ANTHROPIC_MODEL_HEAVY,
        maxTokens: %d,
        timeoutMs: %d
      });
    } else if (isAzureChatConfigured()) {
      text = await azureChatCompletion({""" % (system_expr, max_tokens, timeout_ms)
    assert text.count(branch_old) == 1, ('분기 앵커', path)
    text = text.replace(branch_old, branch_new, 1)
    n += 1

    # 관대 파서 헬퍼 삽입 — export default handler 직전
    anchor = 'export default async function handler'
    assert text.count(anchor) == 1, ('handler 앵커', path)
    text = text.replace(anchor, LOOSE_JSON_HELPER + anchor, 1)
    n += 1

    io.open(path, 'w', encoding='utf-8').write(text)
    print('%s → %d곳 패치' % (path.split('/')[-1], n))


for path, system_expr, max_tokens, timeout_ms in TARGETS:
    patch(path, system_expr, max_tokens, timeout_ms)
print('완료 — JSON.parse 교체는 파일별로 형태가 달라 별도 처리')
