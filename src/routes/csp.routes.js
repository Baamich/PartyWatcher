// routes/csp.routes.js
// Сюда браузер присылает нарушения CSP. Пишем в лог коротко и без повторов.
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const parser = express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '16kb',
});

const seen = new Map(); // нарушение → сколько раз видели

router.post('/', limiter, parser, (req, res) => {
  try {
    const raw = req.body;
    const list = Array.isArray(raw) ? raw.map((r) => r && r.body) : [raw && (raw['csp-report'] || raw)];

    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const blocked = String(r['blocked-uri'] || r.blockedURL || '').slice(0, 200);
      const directive = String(r['violated-directive'] || r.effectiveDirective || '').slice(0, 80);
      const page = String(r['document-uri'] || r.documentURL || '').split('?')[0].slice(0, 200);
      const source = String(r['source-file'] || r.sourceFile || '').slice(0, 120);
      const sample = String(r['script-sample'] || r.sample || '').replace(/\s+/g, ' ').slice(0, 40);
      // расширения браузера (переводчики, тёмные темы, блокировщики) вставляют свои скрипты — это не наш сайт
      if (/^(chrome|moz|safari(-web)?|ms-browser)-extension:/i.test(source) || /^(chrome|moz|safari(-web)?)-extension/i.test(blocked)) continue;

      const key = `${directive}|${blocked}|${page}|${sample}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (seen.size > 500) seen.clear();

      if (n === 1 || n % 50 === 0) {
        const from = source && source !== page ? ` из ${source}` : '';
        const code = sample ? ` «${sample}»` : '';
        console.warn(`[csp] ${directive}: заблокировано ${blocked || '(inline)'}${code}${from} на ${page} (раз: ${n})`);
      }
    }
  } catch (_) {}
  res.status(204).end();
});

module.exports = router;