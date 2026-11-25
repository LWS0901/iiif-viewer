// Vercel 서버리스 함수: POST /api/translate
// 환경 변수 (Vercel → Project → Settings → Environment Variables)
//   GEMINI_API_KEY  (필수) Google AI Studio에서 발급한 키
//   GEMINI_MODEL    (선택) 기본값 gemini-3.8-flash
//   ALLOWED_ORIGIN  (선택) 화면을 다른 도메인(GitHub Pages 등)에 둘 때 그 주소. 예: https://username.github.io

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const LANGS = ['Korean', 'English', 'Japanese', 'Simplified Chinese', 'Traditional Chinese', 'French', 'German', 'Spanish'];
const MAX_BYTES = 120_000;

const SYSTEM = `You translate cultural-heritage metadata from IIIF manifests.
Rules:
- Translate every human-readable string into the target language faithfully and concisely.
- Keep proper nouns sensible: give the conventional target-language name, and if there is none, transliterate and keep the original in parentheses.
- Do NOT translate URLs, identifiers, shelfmarks, call numbers, ISBNs, or dates' numeric parts; keep them exactly.
- Keep line breaks.
- Return ONLY a JSON object with exactly the same keys, structure and array lengths as the input.`;

// 아주 단순한 IP별 요청 제한 (인스턴스 메모리 기준, 분당 20회)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60_000, max = 20;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

function extractJson(text) {
  const t = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('모델 응답에서 JSON을 찾지 못했습니다');
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았습니다' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const { lang, payload } = body || {};
  if (!LANGS.includes(lang)) return res.status(400).json({ error: '지원하지 않는 언어입니다' });
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: '번역할 내용이 없습니다' });
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > MAX_BYTES) return res.status(413).json({ error: '메타데이터가 너무 큽니다' });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: `Target language: ${lang}\n\nInput JSON:\n${input}` }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Gemini 오류: ' + (j.error?.message || r.status) });
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) return res.status(502).json({ error: 'Gemini가 빈 응답을 보냈습니다' + (j.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : '') });
    return res.status(200).json(extractJson(text));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
