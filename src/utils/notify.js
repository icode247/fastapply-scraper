const config = require('../config');
const logger = require('../logger');

async function sendAlert(title, message, level = 'warning') {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = config;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const emoji = level === 'error' ? '🔴' : level === 'warning' ? '🟡' : 'ℹ️';
  const text = `${emoji} *${escapeMarkdown(title)}*\n${escapeMarkdown(message)}`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to send Telegram alert');
  }
}

function escapeMarkdown(text) {
  return text.replace(/([_\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

module.exports = { sendAlert };
