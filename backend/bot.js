const TelegramBot = require('node-telegram-bot-api');
const { db } = require('./db');
const fs = require('fs');

let botInstance = null;

function getToken() {
  return new Promise((resolve) => {
    db.get("SELECT value FROM settings WHERE key = 'bot_token'", [], (err, row) => {
      resolve(row ? row.value : null);
    });
  });
}

async function getBot() {
  const token = await getToken();
  if (!token) return null;

  if (!botInstance) {
    try {
      botInstance = new TelegramBot(token, { polling: false });
    } catch (e) {
      botInstance = null;
    }
  }
  return botInstance;
}

function resetBot() {
  botInstance = null;
}

async function verifyBot(token) {
  try {
    const bot = new TelegramBot(token, { polling: false });
    const me = await bot.getMe();
    return { ok: true, username: me.username, name: me.first_name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function verifyChannel(chatId) {
  const bot = await getBot();
  if (!bot) throw new Error('Bot não configurado');
  try {
    const chat = await bot.getChat(chatId);
    const me = await bot.getMe();
    const member = await bot.getChatMember(chatId, me.id);
    const isAdmin = ['administrator', 'creator'].includes(member.status);
    return {
      ok: true,
      title: chat.title,
      username: chat.username || null,
      type: chat.type,
      isAdmin
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendCampaignToChannel(chatId, campaign, attempt = 1) {
  const bot = await getBot();
  if (!bot) throw new Error('Bot não configurado');

  let buttons = null;
  if (campaign.buttons) {
    try {
      const parsed = JSON.parse(campaign.buttons);
      if (parsed && parsed.length > 0) {
        buttons = {
          inline_keyboard: parsed.map(row =>
            Array.isArray(row)
              ? row.map(btn => ({ text: btn.text, url: btn.url }))
              : [{ text: row.text, url: row.url }]
          )
        };
      }
    } catch (_) {}
  }

  const opts = {
    parse_mode: campaign.parse_mode || 'HTML',
    ...(buttons ? { reply_markup: buttons } : {})
  };

  try {
    if (campaign.image_path && fs.existsSync(campaign.image_path)) {
      return await bot.sendPhoto(chatId, fs.createReadStream(campaign.image_path), {
        caption: campaign.message_text || '',
        parse_mode: campaign.parse_mode || 'HTML',
        ...opts
      });
    }
    return await bot.sendMessage(chatId, campaign.message_text || '', opts);
  } catch (error) {
    // Retry on 429 Too Many Requests
    if (error.response && error.response.statusCode === 429 && attempt <= 3) {
      const retryAfter = (error.response.body && error.response.body.parameters && error.response.body.parameters.retry_after) || 5;
      console.log(`Rate limit (429) for chat ${chatId}. Retrying after ${retryAfter}s (Attempt ${attempt}/3)...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return sendCampaignToChannel(chatId, campaign, attempt + 1);
    }
    throw error;
  }
}

async function deleteMessageFromChannel(chatId, messageId) {
  const bot = await getBot();
  if (!bot) throw new Error('Bot não configurado');
  try {
    return await bot.deleteMessage(chatId, messageId);
  } catch (e) {
    console.error('Failed to delete message:', e.message);
    return false;
  }
}

module.exports = { getBot, resetBot, verifyBot, verifyChannel, sendCampaignToChannel, deleteMessageFromChannel, getToken };
