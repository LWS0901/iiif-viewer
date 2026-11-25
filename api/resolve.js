// Vercel 서버리스 함수: GET /api/resolve?url=<주소>
// 1) 주소가 IIIF 매니페스트면 그대로 가져와 돌려줌 (브라우저에서 CORS로 막힌 경우 대신 가져오기)
// 2) 소장품 웹페이지면 페이지 안에서 IIIF 매니페스트 링크를 찾아 확인한 뒤 돌려줌
const dns = require('dns').promises;
const net = require('net');

const MAX_PAGE = 4_000_000;   // 읽을 최대 크기
const MAX_JSON_OUT = 3_500_000; // 응답에 JSON을 실어 보낼 최대 크기 (Vercel 응답 한도 4.5MB)

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function checkUrl(u) {
  let x; try { x = new URL(u); } catch (e) { throw new Error('주소 형식이 올바르지 않습니다'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('http(s) 주소만 열 수 있습니다');
  if (x.hostname === 'localhost' || x.hostname.endsWith('.local') || x.hostname.endsWith('.internal')) throw new Error('허용되지 않는 주소입니다');
  const addrs = await dns.lookup(x.hostname, { all: true }).catch(() => { throw new Error('주소를 찾을 수 없습니다: ' + x.hostname); });
  if (addrs.some(a => isPrivate(a.address))) throw new Error('허용되지 않는 주소입니다');
  return x;
}

// 리다이렉트도 하나씩 검사하면서 가져오기
async function get(u, ms = 9000) {
  let cur = u;
  for (let i = 0; i < 6; i++) {
    const x = await checkUrl(cur);
    const r = await fetch(x, {
      redirect: 'manual', signal: AbortSignal.timeout(ms),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; IIIF-Viewer/1.0)', accept: 'application/ld+json, application/json;q=0.9, text/html;q=0.8, */*;q=0.5' }
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), x).href; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ctype: r.headers.get('content-type') || '', text: buf.subarray(0, MAX_PAGE).toString('utf8'), url: cur };
  }
  throw new Error('리다이렉트가 너무 많습니다');
}

function iiifJson(text) {
  if (!/^\s*[\[{]/.test(text)) return null;
  let j; try { j = JSON.parse(text); } catch (e) { return null; }
  const t = String(j.type || j['@type'] || '');
  const ctx = JSON.stringify(j['@context'] || '');
  if (/Manifest|Collection/i.test(t) || /iiif\.io\/api\/presentation/.test(ctx)) return j;
  return null;
}

// HTML에서 매니페스트 후보 주소 찾기
function candidates(html, base) {
  const out = new Map();
  const add = (u, score) => {
    try {
      const abs = new URL(u.replace(/&amp;/g, '&').replace(/\\\//g, '/'), base).href;
      if (!/^https?:/.test(abs)) return;
      out.set(abs, Math.max(out.get(abs) || 0, score));
    } catch (e) {}
  };
  // <link rel="alternate" type="application/ld+json;profile=...iiif...">
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (/iiif|presentation|manifest/i.test(tag)) { const h = tag.match(/href\s*=\s*["']([^"']+)/i); if (h) add(h[1], 10); }
  }
  // 뷰어 링크 안의 manifest= / iiif-content= 값
  for (const m of html.matchAll(/[?&#](?:manifest|iiif-content|manifestUri|manifestId)=([^"'&\s<>]+)/gi)) {
    try { const v = decodeURIComponent(decodeURIComponent(m[1])); if (/^https?:/.test(v)) add(v, 9); } catch (e) {}
  }
  // 페이지 안의 절대 주소 중 manifest 가 들어간 것 (JSON 안의 \/ 이스케이프 포함)
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^"'\s<>()\\]+(?:\\\/[^"'\s<>()\\]+)*/gi)) {
    const u = m[0].replace(/\\\//g, '/');
    if (/[?&#](manifest|iiif-content)=/i.test(u)) continue;
    if (/manifest/i.test(u)) add(u, /manifest(\.json)?([?#]|$)/i.test(u) ? 8 : 6);
    else if (/\/iiif\/(?:\d\/)?(?:presentation|.*\/manifest)/i.test(u)) add(u, 5);
  }
  // 상대 경로 링크
  for (const m of html.matchAll(/(?:href|src|data-[\w-]+)\s*=\s*["']([^"']*manifest[^"']*)["']/gi)) {
    if (!/[?&#](manifest|iiif-content)=/i.test(m[1])) add(m[1], 7);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 12);
}

const hits = new Map();
function limited(ip) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr); return arr.length > 30;
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 허용됩니다' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요' });

  const target = String(req.query?.url || '');
  if (!target) return res.status(400).json({ error: 'url 값이 필요합니다' });

  const reply = (url, json, text) => res.status(200).json(text.length <= MAX_JSON_OUT ? { url, json } : { url });

  try {
    const page = await get(target);
    if (page.status >= 400) return res.status(502).json({ error: `페이지를 가져오지 못했습니다 (HTTP ${page.status})` });

    // 1) 주소 자체가 매니페스트
    const direct = iiifJson(page.text);
    if (direct) return reply(page.url, direct, page.text);

    // 2) 웹페이지 안에서 찾기
    const list = candidates(page.text, page.url);
    if (!list.length) return res.status(404).json({ error: '이 페이지에서 IIIF 매니페스트 링크를 찾지 못했습니다' });

    const checked = await Promise.all(list.map(async u => {
      try { const r = await get(u, 7000); const j = r.status < 400 && iiifJson(r.text); return j ? { u, j, text: r.text } : null; }
      catch (e) { return null; }
    }));
    const found = checked.filter(Boolean);
    if (!found.length) return res.status(404).json({ error: '매니페스트처럼 보이는 링크는 있었지만 열 수 있는 것이 없었습니다' });
    const best = found.find(f => /Manifest/i.test(String(f.j.type || f.j['@type']))) || found[0];
    return reply(best.u, best.j, best.text);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
