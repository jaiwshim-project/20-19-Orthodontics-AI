/* ==============================================================
   API Base URL 자동 감지
   - localhost / vercel.app: 같은 도메인의 /api/* 사용
   - github.io: VERCEL_API_BASE의 /api/* 호출 (CORS 필요)
   ============================================================== */

(function () {
  // ⚠️ Vercel 백엔드 배포 후 실제 URL로 변경하세요.
  // 예: 'https://20-19-orthodontics-ai.vercel.app'
  const VERCEL_API_BASE = 'https://20-19-orthodontics-ai.vercel.app';

  function detectBase() {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.vercel.app')) {
      return ''; // same-origin
    }
    if (host.endsWith('.github.io') || host.endsWith('.netlify.app') || host.endsWith('.pages.dev')) {
      return VERCEL_API_BASE;
    }
    return ''; // default same-origin (custom domain on Vercel 등)
  }

  window.API_BASE = detectBase();

  /**
   * fetch 래퍼 — 자동으로 API_BASE 접두사를 붙임.
   * 절대 URL이면 그대로 사용.
   */
  window.apiFetch = function (path, options) {
    const url = /^https?:\/\//.test(path) ? path : window.API_BASE + path;
    return fetch(url, options);
  };

  // 디버그
  if (location.search.includes('debug=1')) {
    console.log('[api-config] host=', location.hostname, 'API_BASE=', window.API_BASE || '(same-origin)');
  }
})();
