const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { scheduleJob, cancelJob, dispatchJob, requestCancel, nextCronRun } = require('../scheduler');
const { getCampaignMedia } = require('../bot');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_MEDIA = 10; // Telegram album limit

function unlinkQuiet(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (err) { console.error('Error deleting file', err); }
  }
}

// Builds the final media list from the request.
// The client sends `media_order` as JSON: [{ existing: "<filename>" } | { new: <index into uploaded files> }]
// so photos and videos keep the order the user arranged. Returns null when the client didn't send it.
async function resolveMedia(req, existingMedia = [], prefix = '') {
  let uploads = req.files && req.files.media;
  uploads = !uploads ? [] : (Array.isArray(uploads) ? uploads : [uploads]);

  let order = null;
  if (req.body.media_order) {
    try { order = JSON.parse(req.body.media_order); } catch (_) {}
  }
  if (!Array.isArray(order)) {
    if (uploads.length === 0) return null;
    order = uploads.map((_, i) => ({ new: i }));
  }
  if (order.length > MAX_MEDIA) throw new Error(`Máximo de ${MAX_MEDIA} fotos/vídeos por mensagem`);

  const saved = {};
  const result = [];
  for (const entry of order) {
    if (entry.existing !== undefined) {
      const found = existingMedia.find(m => path.basename(m.path) === entry.existing);
      if (found) result.push(found);
    } else if (entry.new !== undefined && uploads[entry.new]) {
      if (!saved[entry.new]) {
        const file = uploads[entry.new];
        const isVideo = (file.mimetype || '').startsWith('video/');
        const ext = path.extname(file.name) || (isVideo ? '.mp4' : '.jpg');
        const dest = path.join(UPLOADS_DIR, prefix + uuidv4() + ext);
        await file.mv(dest);
        saved[entry.new] = { path: dest, type: isVideo ? 'video' : 'photo', temp: !!prefix };
      }
      result.push(saved[entry.new]);
    }
  }
  return result;
}

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const campaigns = await db.allAsync(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'pending') as pending_jobs,
        (SELECT COUNT(*) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'running') as running_jobs,
        (SELECT MIN(COALESCE(next_run_at, run_at)) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'pending') as next_run,
        (SELECT COUNT(*) FROM send_log WHERE campaign_id = c.id) as log_count,
        (SELECT COUNT(*) FROM send_log WHERE campaign_id = c.id AND telegram_msg_id IS NOT NULL AND telegram_msg_id != '' AND status IN ('success', 'failed_delete')) as live_messages
      FROM campaigns c
      ORDER BY c.created_at DESC
    `);
    
    // Add computed status
    for (const c of campaigns) {
      if (c.running_jobs > 0) c.status = 'running';
      else if (c.pending_jobs > 0) c.status = 'scheduled';
    }

    res.json(campaigns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    const channels = await db.allAsync(`
      SELECT c.id, c.name, c.chat_id, c.username FROM channels c
      JOIN campaign_channels cc ON cc.channel_id = c.id
      WHERE cc.campaign_id = ?
    `, [req.params.id]);

    const jobs = await db.allAsync(
      'SELECT * FROM scheduled_jobs WHERE campaign_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    const media = getCampaignMedia(campaign).map(m => ({ filename: path.basename(m.path), type: m.type }));

    res.json({ ...campaign, media, channels, jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const { name, message_text, buttons, parse_mode, channel_ids, auto_delete_hours } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    const media = (await resolveMedia(req)) || [];

    const id = uuidv4();
    const autoDeleteVal = auto_delete_hours ? parseInt(auto_delete_hours) : null;
    await db.runAsync(
      `INSERT INTO campaigns (id, name, message_text, media, buttons, parse_mode, auto_delete_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, message_text || '', media.length ? JSON.stringify(media.map(({ path: p, type }) => ({ path: p, type }))) : null, buttons || null, parse_mode || 'HTML', autoDeleteVal]
    );

    // Link channels
    if (channel_ids) {
      const ids = Array.isArray(channel_ids) ? channel_ids : JSON.parse(channel_ids);
      for (const chId of ids) {
        await db.runAsync(
          'INSERT OR IGNORE INTO campaign_channels (campaign_id, channel_id) VALUES (?, ?)',
          [id, chId]
        );
      }
    }

    const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [id]);
    res.json(campaign);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns/test
router.post('/test', async (req, res) => {
  try {
    const { message_text, buttons, parse_mode, test_chat_id, campaign_id } = req.body;
    if (!test_chat_id) return res.status(400).json({ error: 'Chat ID de teste não fornecido' });

    let existingMedia = [];
    if (campaign_id) {
      const existing = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [campaign_id]);
      if (existing) existingMedia = getCampaignMedia(existing);
    }
    const media = (await resolveMedia(req, existingMedia, 'test_')) || existingMedia;

    const campaign = { message_text, buttons, parse_mode: parse_mode || 'HTML', media };
    const { sendCampaignToChannel } = require('../bot');

    try {
      await sendCampaignToChannel(test_chat_id, campaign);
    } finally {
      media.filter(m => m.temp).forEach(m => unlinkQuiet(m.path));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, message_text, buttons, parse_mode, channel_ids, auto_delete_hours } = req.body;

    const existing = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Campanha não encontrada' });

    const existingMedia = getCampaignMedia(existing);
    const media = (await resolveMedia(req, existingMedia)) || existingMedia;

    // Apagar do disco os arquivos que o usuario removeu
    const keptPaths = new Set(media.map(m => m.path));
    existingMedia.filter(m => !keptPaths.has(m.path)).forEach(m => unlinkQuiet(m.path));

    const autoDeleteVal = auto_delete_hours !== undefined
      ? (auto_delete_hours === '' || auto_delete_hours === null ? null : parseInt(auto_delete_hours))
      : existing.auto_delete_hours;

    await db.runAsync(
      `UPDATE campaigns SET name=?, message_text=?, image_path=NULL, media=?, buttons=?, parse_mode=?, auto_delete_hours=?, updated_at=datetime('now')
       WHERE id=?`,
      [name || existing.name, message_text !== undefined ? message_text : existing.message_text, media.length ? JSON.stringify(media.map(({ path: p, type }) => ({ path: p, type }))) : null, buttons !== undefined ? buttons : existing.buttons, parse_mode || existing.parse_mode, autoDeleteVal, req.params.id]
    );

    if (channel_ids !== undefined) {
      const ids = Array.isArray(channel_ids) ? channel_ids : JSON.parse(channel_ids);
      await db.runAsync('DELETE FROM campaign_channels WHERE campaign_id = ?', [req.params.id]);
      for (const chId of ids) {
        await db.runAsync(
          'INSERT OR IGNORE INTO campaign_channels (campaign_id, channel_id) VALUES (?, ?)',
          [req.params.id, chId]
        );
      }
    }

    const updated = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
  try {
    const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    // Cancel active cron jobs
    const jobs = await db.allAsync('SELECT id FROM scheduled_jobs WHERE campaign_id = ? AND status IN ("pending", "running")', [req.params.id]);
    for (const job of jobs) {
      await cancelJob(job.id);
    }

    // Delete attached photos/videos
    getCampaignMedia(campaign).forEach(m => unlinkQuiet(m.path));

    await db.runAsync('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns/:id/send — schedule or fire
router.post('/:id/send', async (req, res) => {
  try {
    const { schedule_type, run_at, cron_expr } = req.body;
    const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    if (schedule_type === 'recurring' && !nextCronRun(cron_expr || '')) {
      return res.status(400).json({ error: 'Expressão cron inválida' });
    }
    if (schedule_type === 'once' && !(new Date(run_at) > new Date())) {
      return res.status(400).json({ error: 'Escolha uma data e hora no futuro' });
    }

    const jobId = uuidv4();
    await db.runAsync(
      `INSERT INTO scheduled_jobs (id, campaign_id, schedule_type, run_at, cron_expr, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [jobId, req.params.id, schedule_type || 'immediate', run_at || null, cron_expr || null,
       run_at || new Date().toISOString()]
    );

    await db.runAsync("UPDATE campaigns SET status = 'scheduled', updated_at = datetime('now') WHERE id = ?", [req.params.id]);

    // Schedule asynchronously
    scheduleJob(jobId).catch(console.error);

    res.json({ ok: true, job_id: jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/campaigns/jobs/:jobId — cancel job
router.delete('/jobs/:jobId', async (req, res) => {
  try {
    const job = await db.getAsync('SELECT campaign_id FROM scheduled_jobs WHERE id = ?', [req.params.jobId]);
    await cancelJob(req.params.jobId);

    // With no schedules left the campaign is no longer "scheduled"
    if (job) {
      const pending = await db.getAsync(
        "SELECT COUNT(*) as n FROM scheduled_jobs WHERE campaign_id = ? AND status IN ('pending', 'running')",
        [job.campaign_id]
      );
      if (pending.n === 0) {
        const sent = await db.getAsync('SELECT COUNT(*) as n FROM send_log WHERE campaign_id = ?', [job.campaign_id]);
        await db.runAsync(
          "UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'",
          [sent.n > 0 ? 'sent' : 'draft', job.campaign_id]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// DELETE /api/campaigns/:id/messages — delete sent messages from Telegram
router.delete('/:id/messages', async (req, res) => {
  try {
    const { deleteMessageFromChannel } = require('../bot');
    
    // Get all send logs for this campaign that have a telegram message ID
    const logs = await db.allAsync(
      "SELECT * FROM send_log WHERE campaign_id = ? AND telegram_msg_id IS NOT NULL AND telegram_msg_id != ''",
      [req.params.id]
    );

    if (logs.length === 0) {
      // Check if there were any logs at all for this campaign (sent without saving message ID)
      const anyLogs = await db.allAsync("SELECT * FROM send_log WHERE campaign_id = ?", [req.params.id]);
      if (anyLogs.length > 0) {
        return res.json({ 
          ok: false, 
          deletedCount: 0, 
          failedCount: anyLogs.length, 
          message: 'Esta campanha foi enviada numa versão antiga do sistema que não salvava os IDs das mensagens. O Telegram não permite apagar mensagens sem o ID.' 
        });
      }
      await db.runAsync("UPDATE campaigns SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      return res.json({ ok: true, deletedCount: 0, failedCount: 0, message: 'Nenhuma mensagem registrada para apagar.' });
    }

    let deletedCount = 0;
    let failedCount = 0;
    const errors = [];

    for (const log of logs) {
      const channel = await db.getAsync('SELECT chat_id, name FROM channels WHERE id = ?', [log.channel_id]);
      if (channel && channel.chat_id) {
        const result = await deleteMessageFromChannel(channel.chat_id, log.telegram_msg_id);
        if (result.ok) {
          deletedCount++;
          await db.runAsync("UPDATE send_log SET status = 'deleted' WHERE id = ?", [log.id]);
        } else {
          failedCount++;
          const channelName = channel.name || channel.chat_id;
          errors.push(`${channelName} → ${result.error || 'Erro ao apagar'}`);
          await db.runAsync("UPDATE send_log SET status = 'failed_delete', error_msg = ? WHERE id = ?", [result.error || 'Falha ao deletar', log.id]);
        }
      }
    }
    
    // Only mark campaign as deleted if ALL messages were successfully deleted (or no failures occurred)
    if (failedCount === 0 && deletedCount > 0) {
      await db.runAsync("UPDATE campaigns SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
    } else if (failedCount > 0) {
      // If some/all failed, revert campaign status to 'sent' so user can see it didn't finish deleting and retry after fixing permissions
      await db.runAsync("UPDATE campaigns SET status = 'sent', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
    }

    res.json({ ok: failedCount === 0, deletedCount, failedCount, failedChannels: errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns/:id/cancel — cancel a running or pending dispatch
router.post('/:id/cancel', async (req, res) => {
  try {
    const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    // Get all running/pending jobs for this campaign
    const jobs = await db.allAsync(
      "SELECT * FROM scheduled_jobs WHERE campaign_id = ? AND status IN ('running', 'pending')",
      [req.params.id]
    );

    for (const job of jobs) {
      if (job.status === 'running') {
        // Signal mid-loop cancellation
        requestCancel(job.id);
      } else {
        // Cancel scheduled/pending jobs
        await cancelJob(job.id);
      }
    }

    // Update campaign status immediately so UI reflects it
    await db.runAsync(
      "UPDATE campaigns SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
      [req.params.id]
    );

    res.json({ ok: true, cancelled: jobs.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/campaigns/emoji-set/:name — fetch a Telegram custom emoji sticker set
router.get('/emoji-set/:name', async (req, res) => {
  try {
    const { getBot } = require('../bot');
    const bot = await getBot();
    if (!bot) return res.status(400).json({ error: 'Bot não configurado' });

    const setName = req.params.name.trim();
    const set = await bot.getStickerSet(setName);

    // Filter to custom_emoji type stickers only
    const emojis = set.stickers
      .filter(s => s.type === 'custom_emoji' && s.custom_emoji_id)
      .map(s => ({
        id: s.custom_emoji_id,
        emoji: s.emoji || '⭐',
        set_name: set.name,
        set_title: set.title,
      }));

    if (emojis.length === 0) {
      return res.status(400).json({ error: `O pack "${set.title}" não contém emojis customizados. Tente outro pack.` });
    }

    res.json({ ok: true, title: set.title, emojis });
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('STICKERSET_INVALID') || msg.includes('not found') || msg.includes('Bad Request')) {
      return res.status(404).json({ error: `Pack "${req.params.name}" não encontrado. Verifique o nome e tente novamente.` });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
