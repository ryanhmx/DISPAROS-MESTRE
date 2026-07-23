const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { verifyBot, resetBot } = require('../bot');

// GET /api/stats/overview
router.get('/overview', async (req, res) => {
  try {
    const totalChannels = await db.getAsync('SELECT COUNT(*) as n FROM channels');
    const activeChannels = await db.getAsync('SELECT COUNT(*) as n FROM channels WHERE active = 1');
    const totalCampaigns = await db.getAsync('SELECT COUNT(*) as n FROM campaigns');
    const totalSent = await db.getAsync("SELECT COUNT(*) as n FROM send_log WHERE status = 'success'");
    const totalFailed = await db.getAsync("SELECT COUNT(*) as n FROM send_log WHERE status = 'failed'");
    const pendingJobs = await db.getAsync("SELECT COUNT(*) as n FROM scheduled_jobs WHERE status = 'pending'");
    const recentLog = await db.allAsync(`
      SELECT sl.*, c.name as campaign_name
      FROM send_log sl
      LEFT JOIN campaigns c ON c.id = sl.campaign_id
      ORDER BY sl.sent_at DESC
      LIMIT 10
    `);
    const upcomingJobs = await db.allAsync(`
      SELECT sj.*, c.name as campaign_name
      FROM scheduled_jobs sj
      JOIN campaigns c ON c.id = sj.campaign_id
      WHERE sj.status = 'pending' AND sj.schedule_type != 'immediate'
      ORDER BY sj.run_at ASC
      LIMIT 5
    `);

    res.json({
      totalChannels: totalChannels.n,
      activeChannels: activeChannels.n,
      totalCampaigns: totalCampaigns.n,
      totalSent: totalSent.n,
      totalFailed: totalFailed.n,
      pendingJobs: pendingJobs.n,
      recentLog,
      upcomingJobs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats/log
router.get('/log', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, campaign_id } = req.query;
    const offset = (page - 1) * limit;
    let where = [];
    let params = [];
    if (status) { where.push('sl.status = ?'); params.push(status); }
    if (campaign_id) { where.push('sl.campaign_id = ?'); params.push(campaign_id); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const logs = await db.allAsync(`
      SELECT sl.*, c.name as campaign_name
      FROM send_log sl
      LEFT JOIN campaigns c ON c.id = sl.campaign_id
      ${whereClause}
      ORDER BY sl.sent_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const total = await db.getAsync(
      `SELECT COUNT(*) as n FROM send_log sl ${whereClause}`, params
    );

    res.json({ logs, total: total.n, page: Number(page), limit: Number(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats/settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT * FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    // Never expose token in full
    if (settings.bot_token) settings.bot_token = '***' + settings.bot_token.slice(-6);
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stats/settings/token
router.post('/settings/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token é obrigatório' });
    const result = await verifyBot(token);
    if (!result.ok) return res.status(400).json({ error: result.error });

    await db.runAsync(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('bot_token', ?)",
      [token]
    );
    resetBot();
    res.json({ ok: true, bot_username: result.username, bot_name: result.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
