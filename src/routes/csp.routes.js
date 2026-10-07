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

      const key = `${directive}|${blocked}|${page}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (seen.size > 500) seen.clear();

      if (n === 1 || n % 50 === 0) {
        console.warn(`[csp] ${directive}: заблокировано ${blocked || '(inline)'} на ${page} (раз: ${n})`);
      }
    }
  } catch (_) {}
  res.status(204).end();
});

module.exports = router;