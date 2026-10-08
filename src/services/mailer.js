// services/mailer.js
// Отправка служебных писем (сброс пароля) через SMTP.
// Настройки — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM в .env.
// Если SMTP не настроен, письма не отправляются, а в лог пишется только факт (без ссылок и токенов).
const nodemailer = require('nodemailer');

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

async function sendMail({ to, subject, text, html }) {
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
    headers: { 'Auto-Submitted': 'auto-generated' }, // автоответчики не будут отвечать на служебное письмо
  });
  return true;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// У письма есть и текстовая, и HTML-версия: письма только с HTML спам-фильтры любят меньше
async function sendPasswordReset(to, username, link, ttlMinutes) {
  const subject = 'Сброс пароля PartyWatcher';
  const text =
    `Здравствуйте, ${username}!\n\n` +
    `Кто-то (возможно, вы) запросил сброс пароля на PartyWatcher.\n` +
    `Чтобы задать новый пароль, откройте ссылку (действует ${ttlMinutes} минут):\n\n${link}\n\n` +
    `Если вы ничего не запрашивали, просто проигнорируйте это письмо — пароль останется прежним.\n\n` +
    `— PartyWatcher`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:520px">` +
    `<p>Здравствуйте, ${escapeHtml(username)}!</p>` +
    `<p>Кто-то (возможно, вы) запросил сброс пароля на PartyWatcher.</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#6c5ce7;color:#fff;border-radius:8px;text-decoration:none">Задать новый пароль</a></p>` +
    `<p style="color:#666;font-size:13px">Ссылка действует ${ttlMinutes} минут. Если вы ничего не запрашивали, просто проигнорируйте письмо — пароль останется прежним.</p>` +
    `</div>`;
  return sendMail({ to, subject, text, html });
}

module.exports = { sendMail, sendPasswordReset, isMailConfigured };
