(function () {
  const VERCEL_API_BASE = 'https://20-19-orthodontics-ai.vercel.app';
  const LOCAL_API_BASE = 'http://localhost:3000';

  function detectBase() {
    if (location.protocol === 'file:') return LOCAL_API_BASE;

    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.vercel.app')) return '';
    if (host.endsWith('.github.io') || host.endsWith('.netlify.app') || host.endsWith('.pages.dev')) return VERCEL_API_BASE;
    return '';
  }

  window.API_BASE = detectBase();
  window.apiFetch = function apiFetch(path, options) {
    const url = /^https?:\/\//.test(path) ? path : window.API_BASE + path;
    return fetch(url, options);
  };

  if (location.search.includes('debug=1')) {
    console.log('[api-config] host=', location.hostname, 'API_BASE=', window.API_BASE || '(same-origin)');
  }
})();
