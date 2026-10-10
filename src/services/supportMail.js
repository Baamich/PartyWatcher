// services/supportMail.js
// Письма поддержки: ответ админа, «принято», «пустяк». Тексты — server.mail.support.* на языке обращения (ticket.lang).
// Каждое письмо содержит историю переписки цитатой и заголовки Message-ID / In-Reply-To / References:
// почтовый клиент человека складывает письма в одну цепочку, а его ответ (на support@) находит свой тикет.
const crypto = require('crypto');
const i18n = require('./i18n');
const { sendMail, escapeHtml } = require('./mailer');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@partywatcher.de'; // сюда человек отвечает (Reply-To)
const MAIL_DOMAIN = SUPPORT_EMAIL.split('@')[1] || 'partywatcher.de';
const HISTORY_MAX = 6000; // символов цитаты в письме

// <pw-ticket-<id>-<случайное>@домен>: по id в нём ответ человека находит тикет
function newMessageId(ticketId) {
  return `<pw-ticket-${ticketId}-${crypto.randomBytes(6).toString('hex')}@${MAIL_DOMAIN}>`;
}

function ticketIdFromRefs(refs) {
  for (const r of refs) {
    const m = String(r).match(/pw-ticket-([a-f0-9]{24})-/i);
    if (m) return m[1];
  }
  return null;
}

function fmtDate(d, lang) {
  try {
    return new Date(d).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', {
      timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' UTC';
  } catch (_) {
    return '';
  }
}

function tr(lang, key, vars) {
  return i18n.t(lang, 'server.mail.support.' + key, vars);
}

function subjectOf(ticket) {
  return `${tr(ticket.lang, 'subject')} [#${ticket.number}]`;
}

// подпись: «С уважением, служба поддержки» (+ кто ответил — у живого ответа)
function signature(lang, author) {
  const lines = [tr(lang, 'regards'), tr(lang, 'team')];
  if (author) lines.push(tr(lang, 'answeredBy', { name: author }));
  return lines.join('\n');
}

// история переписки, свежие сверху: исходное обращение и все сообщения
function history(ticket) {
  const lang = ticket.lang;
  const items = [{ head: tr(lang, 'historyRequest', { n: ticket.number, date: fmtDate(ticket.createdAt, lang) }), text: ticket.description }];
  for (const m of ticket.messages || []) {
    const who = m.from === 'user' ? tr(lang, 'historyYou') : tr(lang, 'historySupport');
    items.push({ head: `${who}, ${fmtDate(m.at, lang)}:`, text: m.text });
  }
  let out = '';
  for (const it of items.reverse()) {
    const block = `${it.head}\n${String(it.text || '').split('\n').map((l) => '> ' + l).join('\n')}\n\n`;
    if (out.length + block.length > HISTORY_MAX) break;
    out += block;
  }
  return out.trim();
}

// текст письма без подписи и истории: приветствие + основной текст
function mainText(ticket, kind, text) {
  const lang = ticket.lang;
  const hello = ticket.name ? tr(lang, 'helloName', { name: ticket.name }) : tr(lang, 'hello');
  if (kind === 'reply') return `${hello}\n\n${text}`;
  return `${hello}\n\n${tr(lang, kind, { n: ticket.number })}\n\n${tr(lang, kind + 'Bye')}`;
}

// нижний блок письма, который нельзя редактировать: подпись + история (его же видит админ перед отправкой)
function footer(ticket, author) {
  return `${signature(ticket.lang, author)}\n\n${tr(ticket.lang, 'historyTitle')}\n\n${history(ticket)}`;
}

function toHtml(main, foot) {
  const p = (s) => escapeHtml(s).replace(/\n/g, '<br>');
  const [sig, ...rest] = foot.split('\n\n');
  const quoted = rest.join('\n\n');
  return (
    '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:620px">' +
    `<p>${p(main)}</p>` +
    `<p>${p(sig)}</p>` +
    `<div style="margin-top:18px;padding-left:12px;border-left:3px solid #ccc;color:#666;font-size:13px">${p(quoted)}</div>` +
    '</div>'
  );
}

// kind: reply | accepted | trivial. Возвращает { emailed, messageId }. Тикет не меняет — это делает роут.
async function sendSupportEmail(ticket, kind, { text = '', author = '' } = {}) {
  if (!ticket.email) return { emailed: false, messageId: null };
  const main = mainText(ticket, kind, text);
  const foot = footer(ticket, kind === 'reply' ? author : '');
  const messageId = newMessageId(ticket._id);
  const ids = (ticket.mailIds || []).slice(-10);
  const emailed = await sendMail({
    to: ticket.email,
    subject: subjectOf(ticket),
    text: `${main}\n\n${foot}`,
    html: toHtml(main, foot),
    replyTo: SUPPORT_EMAIL,
    messageId,
    inReplyTo: ids.length ? ids[ids.length - 1] : undefined,
    references: ids.length ? ids.join(' ') : undefined,
    autoSubmitted: kind !== 'reply',
  });
  return { emailed, messageId: emailed ? messageId : null };
}

module.exports = { sendSupportEmail, footer, subjectOf, ticketIdFromRefs, SUPPORT_EMAIL };
