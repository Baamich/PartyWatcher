const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

router.post('/extract', auth, async (req, res) => {
  res.json({
    success: false,
    error: 'Puppeteer временно отключён — чиним Chrome',
    streams: [],
    playerIframes: [],
    meta: null,
  });
});

module.exports = router;