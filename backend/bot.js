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

const CAPTION_LIMIT = 1024;
const ALBUM_LIMIT = 10;

// Returns the campaign's attachments as [{ path, type }], falling back to the legacy image_path column
function getCampaignMedia(campaign) {
  if (campaign.media) {
    try {
      const parsed = typeof campaign.media === 'string' ? JSON.parse(campaign.media) : campaign.media;
      if (Array.isArray(parsed)) return parsed.filter(m => m && m.path);
    } catch (_) {}
  }
  if (campaign.image_path) return [{ path: campaign.image_path, type: 'photo' }];
  return [];
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

  const parseMode = campaign.parse_mode || 'HTML';
  const text = campaign.message_text || '';
  const opts = {
    parse_mode: parseMode,
    ...(buttons ? { reply_markup: buttons } : {})
  };

  const media = getCampaignMedia(campaign)
    .filter(m => fs.existsSync(m.path))
    .slice(0, ALBUM_LIMIT);

  // Telegram doesn't count HTML tags toward the caption limit
  const captionFits = text.replace(/<[^>]*>/g, '').length <= CAPTION_LIMIT;

  try {
    const messageIds = [];

    if (media.length === 0) {
      const msg = await bot.sendMessage(chatId, text, opts);
      messageIds.push(msg.message_id);
    } else if (media.length === 1) {
      const item = media[0];
      const sendFn = item.type === 'video' ? bot.sendVideo.bind(bot) : bot.sendPhoto.bind(bot);
      const extra = item.type === 'video' ? { supports_streaming: true } : {};
      if (captionFits) {
        const msg = await sendFn(chatId, fs.createReadStream(item.path), { caption: text, ...opts, ...extra });
        messageIds.push(msg.message_id);
      } else {
        // Caption too long: send the media alone, then the full text with the buttons
        const msg = await sendFn(chatId, fs.createReadStream(item.path), extra);
        messageIds.push(msg.message_id);
        const textMsg = await bot.sendMessage(chatId, text, opts);
        messageIds.push(textMsg.message_id);
      }
    } else {
      // Albums can't carry inline buttons, so when there are buttons (or the caption
      // is too long) the text goes in a separate message right after the album
      const captionInAlbum = captionFits && !buttons && text;
      const group = media.map((item, i) => ({
        type: item.type === 'video' ? 'video' : 'photo',
        media: fs.createReadStream(item.path),
        ...(item.type === 'video' ? { supports_streaming: true } : {}),
        ...(i === 0 && captionInAlbum ? { caption: text, parse_mode: parseMode } : {})
      }));
      const msgs = await bot.sendMediaGroup(chatId, group);
      msgs.forEach(m => messageIds.push(m.message_id));

      if (!captionInAlbum && (text || buttons)) {
        const textMsg = await bot.sendMessage(chatId, text || '👇', opts);
        messageIds.push(textMsg.message_id);
      }
    }

    return { message_id: messageIds[0], message_ids: messageIds };
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

  // Albums are stored as comma-separated message ids
  const ids = String(messageId).split(',').map(id => id.trim()).filter(Boolean);
  const errors = [];
  for (const id of ids) {
    try {
      await bot.deleteMessage(chatId, id);
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('message to delete not found')) continue;
      console.error(`Failed to delete message ${id} in chat ${chatId}:`, msg);
      errors.push(msg);
    }
  }
  if (errors.length > 0) return { ok: false, error: errors[0] };
  return { ok: true };
}

module.exports = { getCampaignMedia, getBot, resetBot, verifyBot, verifyChannel, sendCampaignToChannel, deleteMessageFromChannel, getToken };
