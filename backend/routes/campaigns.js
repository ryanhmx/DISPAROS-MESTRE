const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { scheduleJob, cancelJob, dispatchJob, requestCancel } = require('../scheduler');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const campaigns = await db.allAsync(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'pending') as pending_jobs,
        (SELECT COUNT(*) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'running') as running_jobs,
        (SELECT MIN(run_at) FROM scheduled_jobs WHERE campaign_id = c.id AND status = 'pending') as next_run
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

    res.json({ ...campaign, channels, jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const { name, message_text, buttons, parse_mode, channel_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    let image_path = null;
    if (req.files && req.files.image) {
      const img = req.files.image;
      const ext = path.extname(img.name) || '.jpg';
      image_path = path.join(UPLOADS_DIR, uuidv4() + ext);
      await img.mv(image_path);
    }

    const id = uuidv4();
    await db.runAsync(
      `INSERT INTO campaigns (id, name, message_text, image_path, buttons, parse_mode)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, message_text || '', image_path, buttons || null, parse_mode || 'HTML']
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
    const { message_text, buttons, parse_mode, test_chat_id, campaign_id, remove_image } = req.body;
    if (!test_chat_id) return res.status(400).json({ error: 'Chat ID de teste não fornecido' });

    let image_path = null;
    let temp_image = false;

    if (req.files && req.files.image) {
      const img = req.files.image;
      const ext = path.extname(img.name) || '.jpg';
      image_path = path.join(UPLOADS_DIR, 'test_' + uuidv4() + ext);
      await img.mv(image_path);
      temp_image = true;
    } else if (campaign_id && remove_image !== 'true') {
      const existing = await db.getAsync('SELECT image_path FROM campaigns WHERE id = ?', [campaign_id]);
      if (existing && existing.image_path) {
        image_path = existing.image_path;
      }
    }

    const campaign = { message_text, buttons, parse_mode: parse_mode || 'HTML', image_path };
    const { sendCampaignToChannel } = require('../bot');
    
    await sendCampaignToChannel(test_chat_id, campaign);

    if (temp_image && fs.existsSync(image_path)) {
      try { fs.unlinkSync(image_path); } catch(e){}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/campaigns/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, message_text, buttons, parse_mode, channel_ids, remove_image } = req.body;

    let image_path_update = null;
    if (req.files && req.files.image) {
      const img = req.files.image;
      const ext = path.extname(img.name) || '.jpg';
      image_path_update = path.join(UPLOADS_DIR, uuidv4() + ext);
      await img.mv(image_path_update);
    }

    const existing = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Campanha não encontrada' });

    let finalImagePath = image_path_update || existing.image_path;

    // Se uma nova imagem foi enviada ou o usuario clicou em remover, apagar a antiga
    if ((image_path_update || remove_image === 'true') && existing.image_path && fs.existsSync(existing.image_path)) {
      try { fs.unlinkSync(existing.image_path); } catch(err) { console.error('Error deleting old image', err); }
      if (remove_image === 'true' && !image_path_update) {
        finalImagePath = null;
      }
    }

    await db.runAsync(
      `UPDATE campaigns SET name=?, message_text=?, image_path=?, buttons=?, parse_mode=?, updated_at=datetime('now')
       WHERE id=?`,
      [name || existing.name, message_text !== undefined ? message_text : existing.message_text, finalImagePath, buttons !== undefined ? buttons : existing.buttons, parse_mode || existing.parse_mode, req.params.id]
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

    // Delete image if exists
    if (campaign.image_path && fs.existsSync(campaign.image_path)) {
      try { fs.unlinkSync(campaign.image_path); } catch(err) { console.error('Error deleting image', err); }
    }

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
    await cancelJob(req.params.jobId);
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
    // Check all logs regardless of status in case previous deletion attempts failed or incorrectly set status
    const logs = await db.allAsync(
      "SELECT * FROM send_log WHERE campaign_id = ? AND telegram_msg_id IS NOT NULL AND telegram_msg_id != ''",
      [req.params.id]
    );

    if (logs.length === 0) {
      await db.runAsync("UPDATE campaigns SET status = 'deleted', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      return res.json({ ok: true, deletedCount: 0, failedCount: 0 });
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
          errors.push(channel.name || channel.chat_id);
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

module.exports = router;
