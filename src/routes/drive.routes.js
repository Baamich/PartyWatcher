const express = require('express');
const { Readable } = require('stream');
const router = express.Router();
const auth = require('../middleware/auth');
const config = require('../config');

router.get('/stream/:fileId', auth, async (req, res) => {
  const { fileId } = req.params;
  // id файла: только буквы, цифры, _ и -. Иначе в адрес запроса (с твоим API-ключом) можно подмешать чужой путь
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) {
    return res.status(400).json({ error: req.t('server.drive.badId') });
  }
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${config.drive.apiKey}`;

  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const driveRes = await fetch(driveUrl, { headers });

    if (!driveRes.ok) {
      return res.status(driveRes.status).json({
        error: req.t('server.drive.fetchFailed'),
      });
    }

    res.status(driveRes.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const value = driveRes.headers.get(h);
      if (value) res.setHeader(h, value);
    });

    Readable.fromWeb(driveRes.body).pipe(res);
  } catch (err) {
    console.error('[drive] stream error:', err);
    res.status(500).json({ error: req.t('server.drive.streamError') });
  }
});

module.exports = router;