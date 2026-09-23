// voice.routes.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const auth = require('../middleware/auth');
const config = require('../config');

router.get('/ice-servers', auth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  const {
    turnUrl, turnSecret, turnTtlSeconds,
    staticTurnUrls, staticTurnUsername, staticTurnCredential,
  } = config.turn || {};

  // Приоритет — свой coturn с HMAC-кредами (безопаснее, без лимитов)
  if (turnUrl && turnSecret) {
    const ttl = turnTtlSeconds || 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${req.user.id}`;
    const credential = crypto
      .createHmac('sha1', turnSecret)
      .update(username)
      .digest('base64');

    iceServers.push({
      urls: [`turn:${turnUrl}?transport=udp`, `turn:${turnUrl}?transport=tcp`],
      username,
      credential,
    });
  } else if (staticTurnUrls?.length && staticTurnUsername && staticTurnCredential) {
    // Фолбэк — публичный TURN со статичными кредами (например Open Relay Project)
    iceServers.push({
      urls: staticTurnUrls,
      username: staticTurnUsername,
      credential: staticTurnCredential,
    });
  }

  res.json({ iceServers, ttlSeconds: turnTtlSeconds || 3600 });
});

module.exports = router;