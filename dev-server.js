/**
 * Local Dev Server
 * - 정적 파일(HTML/JS/CSS) 서빙
 * - /api/*.js 동적 라우팅 (Vercel Serverless 호환)
 * - .env.local 자동 로드
 *
 * 실행: node dev-server.js  →  http://localhost:3000
 */
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { extname, join, normalize } from 'path';
import { pathToFileURL } from 'url';

// -------- .env.local 로드 --------
const ROOT = process.cwd();
const envPath = join(ROOT, '.env.local');
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, 'utf8');
  envText.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  });
  console.log('[env] .env.local 로드 완료');
} else {
  console.warn('[env] .env.local 없음 — Gemini 호출 시 폴백 응답 사용');
}

// -------- MIME 타입 --------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.cypher':'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.sql':  'text/plain; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8'
};

// -------- Body Parser (JSON) --------
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 30 * 1024 * 1024; // 30MB
    req.on('data', c => {
      total += c.length;
      if (total > LIMIT) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try { resolve(text ? JSON.parse(text) : {}); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      } else {
        resolve(text);
      }
    });
    req.on('error', reject);
  });
}

// -------- Vercel-style Response Wrapper --------
function makeRes(nodeRes) {
  let statusSet = false;
  return {
    status(code) { nodeRes.statusCode = code; statusSet = true; return this; },
    json(obj) {
      if (!statusSet) nodeRes.statusCode = 200;
      nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      nodeRes.end(JSON.stringify(obj));
      return this;
    },
    send(data) {
      if (!statusSet) nodeRes.statusCode = 200;
      nodeRes.end(data);
      return this;
    },
    end(data) {
      if (data !== undefined) nodeRes.end(data);
      else nodeRes.end();
      return this;
    },
    setHeader(k, v) { nodeRes.setHeader(k, v); return this; },
    getHeader(k) { return nodeRes.getHeader(k); }
  };
}

// -------- 동적 핸들러 캐시 --------
const handlerCache = new Map();
async function loadHandler(apiPath) {
  // 매번 새로 로드 (개발 중 핫리로드)
  const url = pathToFileURL(apiPath).href + '?t=' + Date.now();
  const mod = await import(url);
  return mod.default;
}

// -------- 서버 --------
const server = createServer(async (nodeReq, nodeRes) => {
  // CORS (개발용)
  nodeRes.setHeader('Access-Control-Allow-Origin', '*');
  nodeRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  nodeRes.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (nodeReq.method === 'OPTIONS') { nodeRes.statusCode = 204; nodeRes.end(); return; }

  const [pathname, queryString] = (nodeReq.url || '/').split('?');
  const url = decodeURIComponent(pathname);

  // -------- API 라우팅 --------
  if (url.startsWith('/api/')) {
    const segments = url.replace(/^\/api\//, '').split('/').filter(Boolean);
    if (segments.length === 0) {
      nodeRes.statusCode = 404;
      nodeRes.end(JSON.stringify({ error: 'API name required' }));
      return;
    }
    const apiName = segments[0];
    const apiPath = join(ROOT, 'api', apiName + '.js');
    if (!existsSync(apiPath)) {
      nodeRes.statusCode = 404;
      nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
      nodeRes.end(JSON.stringify({ error: `API not found: /api/${apiName}` }));
      return;
    }
    try {
      let body = {};
      if (nodeReq.method === 'POST' || nodeReq.method === 'PUT') {
        try {
          body = await readBody(nodeReq);
        } catch (e) {
          nodeRes.statusCode = 400;
          nodeRes.end(JSON.stringify({ error: 'Body parse error: ' + e.message }));
          return;
        }
      }
      // Query string parsing (간단)
      const query = {};
      if (queryString) {
        for (const pair of queryString.split('&')) {
          const [k, v = ''] = pair.split('=');
          if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
        }
      }
      const handler = await loadHandler(apiPath);
      if (typeof handler !== 'function') {
        nodeRes.statusCode = 500;
        nodeRes.end(JSON.stringify({ error: `API ${apiName} has no default export function` }));
        return;
      }
      const fakeReq = {
        method: nodeReq.method,
        url: nodeReq.url,
        headers: nodeReq.headers,
        body,
        query
      };
      const fakeRes = makeRes(nodeRes);
      console.log(`[api] ${nodeReq.method} /api/${apiName}`);
      await handler(fakeReq, fakeRes);
    } catch (e) {
      console.error(`[api] /api/${apiName} 처리 실패:`, e);
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 500;
        nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
        nodeRes.end(JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0, 3).join('\n') }));
      }
    }
    return;
  }

  // -------- 정적 파일 --------
  let filePath = url === '/' ? '/index.html' : url;
  // path traversal 방지
  filePath = normalize(join(ROOT, filePath));
  if (!filePath.startsWith(ROOT)) {
    nodeRes.statusCode = 403; nodeRes.end('Forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    nodeRes.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    nodeRes.setHeader('Cache-Control', 'no-cache');
    nodeRes.end(data);
  } catch (e) {
    nodeRes.statusCode = 404;
    nodeRes.setHeader('Content-Type', 'text/html; charset=utf-8');
    nodeRes.end(`<html><body style="font-family:sans-serif;padding:24px;background:#0B1220;color:#E5E7EB"><h1>404 — Not Found</h1><p>${url}</p></body></html>`);
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log('═════════════════════════════════════════════════');
  console.log(`  Orthodontics AI · Local Dev Server`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → http://localhost:${PORT}/3d-viewer.html`);
  console.log(`  → http://localhost:${PORT}/extraction-ai.html`);
  console.log('─────────────────────────────────────────────────');
  console.log(`  GEMINI_API_KEY:   ${process.env.GEMINI_API_KEY ? '✓ 로드됨' : '✗ 없음 (폴백 동작)'}`);
  console.log(`  SUPABASE_URL:     ${process.env.SUPABASE_URL ? '✓' : '✗ (선택)'}`);
  console.log('═════════════════════════════════════════════════');
});
