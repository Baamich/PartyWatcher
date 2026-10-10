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
  return true;
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

module.exports = { sendMail, sendPasswordReset, isMailConfigured, escapeHtml };
