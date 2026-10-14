// services/mailer.js
// Отправка служебных писем (сброс пароля) через SMTP.
// Настройки — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM в .env.
// Если SMTP не настроен, письма не отправляются, а в лог пишется только факт (без ссылок и токенов).
const nodemailer = require('nodemailer');
const i18n = require('./i18n');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 — сразу TLS, 587 — STARTTLS
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 2,
  });
  return transporter;
}

function isMailConfigured() {
  return !!process.env.SMTP_HOST && !!process.env.MAIL_FROM;
}

// extra: replyTo, messageId, inReplyTo, references — для переписки поддержки (письма складываются в одну цепочку)
async function sendMail({ to, subject, text, html, replyTo, messageId, inReplyTo, references, autoSubmitted = true }) {
  const t = getTransporter();
  if (!t || !process.env.MAIL_FROM) {
    console.warn('[mailer] SMTP не настроен (SMTP_HOST / MAIL_FROM) — письмо не отправлено');
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM, // например: "PartyWatcher <noreply@partywatcher.de>"
      to,
      subject,
      text,
      html,
      replyTo,
      messageId,
      inReplyTo,
      references,
      // автоответчики не будут отвечать на служебное письмо; живой ответ поддержки так не помечаем
      headers: autoSubmitted ? { 'Auto-Submitted': 'auto-generated' } : {},
    });
  } catch (e) {
    // код и ответ SMTP-сервера (535 — неверный ключ, ETIMEDOUT — порт закрыт); адрес — замаскированный
    console.error(`[mailer] НЕ отправлено → ${maskEmail(to)}: ${e.code || ''} ${e.responseCode || ''} ${(e.response || e.message || '').slice(0, 200)}`);
    // почтовый сервис сказал «лимит» раньше нашего счёта — до конца суток больше не пробуем (services/mailQuota.js)
    const quota = require('./mailQuota');
    if (quota.isQuotaError(e)) await quota.markFull().catch(() => {});
    throw e;
  }
  console.log(`[mailer] отправлено → ${maskEmail(to)}`);
  return true;
}

// «b***@gmail.com» — в лог не пишем адреса целиком
function maskEmail(addr) {
  const m = String(addr || '').match(/^(.)[^@]*(@.*)$/);
  return m ? m[1] + '***' + m[2] : '?';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// У письма есть и текстовая, и HTML-версия: письма только с HTML спам-фильтры любят меньше.
// Тексты — в словаре server.mail.reset.* (src/locales), язык — тот, на котором открыт сайт при запросе.
async function sendPasswordReset(to, username, link, ttlMinutes, lang) {
  const tr = (key, vars) => i18n.t(lang, 'server.mail.reset.' + key, vars);
  const subject = tr('subject');
  const text =
    `${tr('hello', { name: username })}\n\n` +
    `${tr('requested')}\n` +
    `${tr('openLink', { n: ttlMinutes })}\n\n${link}\n\n` +
    `${tr('ignore')}\n\n` +
    `— PartyWatcher`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">` +
    `<p>${escapeHtml(tr('hello', { name: username }))}</p>` +
    `<p>${escapeHtml(tr('requested'))}</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#6c5ce7;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(tr('button'))}</a></p>` +
    `<p style="color:#666;font-size:13px">${escapeHtml(tr('footer', { n: ttlMinutes }))}</p>` +
    `</div>`;
  return sendMail({ to, subject, text, html });
}

// Письмо подтверждения почты после регистрации: кнопка и та же ссылка обычным текстом (если кнопка не нажимается)
async function sendVerifyEmail(to, username, link, ttlMinutes, lang) {
  // письмо из очереди регистраций — ссылка на часы («в течение 8 часов»), обычное — на минуты
  const hours = ttlMinutes >= 120 && ttlMinutes % 60 === 0;
  const tr = (key, vars) => i18n.t(lang, 'server.mail.verify.' + (hours && (key === 'openLink' || key === 'footer') ? key + 'H' : key),
    hours && vars && vars.n ? { ...vars, n: vars.n / 60 } : vars);
  const subject = tr('subject');
  const text =
    `${tr('hello', { name: username })}\n\n` +
    `${tr('intro')}\n` +
    `${tr('openLink', { n: ttlMinutes })}\n\n${link}\n\n` +
    `${tr('ignore')}\n\n` +
    `— PartyWatcher`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">` +
    `<p>${escapeHtml(tr('hello', { name: username }))}</p>` +
    `<p>${escapeHtml(tr('intro'))}</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#6c5ce7;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(tr('button'))}</a></p>` +
    `<p style="font-size:13px;color:#444">${escapeHtml(tr('linkHint'))}<br><a href="${escapeHtml(link)}" style="color:#6c5ce7;word-break:break-all">${escapeHtml(link)}</a></p>` +
    `<p style="color:#666;font-size:13px">${escapeHtml(tr('footer', { n: ttlMinutes }))}</p>` +
    `</div>`;
  return sendMail({ to, subject, text, html });
}

module.exports = { sendMail, sendPasswordReset, sendVerifyEmail, isMailConfigured, escapeHtml, maskEmail };
