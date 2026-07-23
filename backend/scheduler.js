const cron = require('node-cron');
const cronParser = require('cron-parser');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { sendCampaignToChannel } = require('./bot');

const activeCronJobs = {}; // jobId -> cron task

async function dispatchJob(jobId) {
  const job = await db.getAsync('SELECT * FROM scheduled_jobs WHERE id = ?', [jobId]);
  if (!job) return;
  if (job.status === 'cancelled' || job.status === 'done') return;

  // Mark as running
  await db.runAsync("UPDATE scheduled_jobs SET status = 'running' WHERE id = ?", [jobId]);

  const campaign = await db.getAsync('SELECT * FROM campaigns WHERE id = ?', [job.campaign_id]);
  if (!campaign) return;

  // Get channels for this campaign
  const channels = await db.allAsync(`
    SELECT c.* FROM channels c
    JOIN campaign_channels cc ON cc.channel_id = c.id
    WHERE cc.campaign_id = ? AND c.active = 1
  `, [campaign.id]);

  if (channels.length === 0) {
    const logId = uuidv4();
    await db.runAsync(`
      INSERT INTO send_log (id, job_id, campaign_id, channel_id, channel_name, status, error_msg)
      VALUES (?, ?, ?, 'none', 'Nenhum Canal', 'failed', 'Nenhum canal ativo selecionado para esta campanha')
    `, [logId, jobId, campaign.id]);
    
    await db.runAsync("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?", [jobId]);
    await db.runAsync("UPDATE campaigns SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [campaign.id]);
    return;
  }

  let allOk = true;
  for (const ch of channels) {
    await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay per channel
    const logId = uuidv4();
    try {
      const res = await sendCampaignToChannel(ch.chat_id, campaign);
      await db.runAsync(`
        INSERT INTO send_log (id, job_id, campaign_id, channel_id, channel_name, status, telegram_msg_id)
        VALUES (?, ?, ?, ?, ?, 'success', ?)
      `, [logId, jobId, campaign.id, ch.id, ch.name, String(res.message_id || '')]);
    } catch (err) {
      allOk = false;
      await db.runAsync(`
        INSERT INTO send_log (id, job_id, campaign_id, channel_id, channel_name, status, error_msg)
        VALUES (?, ?, ?, ?, ?, 'failed', ?)
      `, [logId, jobId, campaign.id, ch.id, ch.name, err.message]);
    }
  }

  if (!allOk) {
    try {
      const adminSetting = await db.getAsync("SELECT value FROM settings WHERE key = 'admin_chat_id'");
      if (adminSetting && adminSetting.value) {
        await sendCampaignToChannel(adminSetting.value, {
          message_text: `⚠️ *Falha no Envio*\n\nA campanha *${campaign.name}* apresentou erro ao enviar para um ou mais canais. Acesse o histórico no painel para ver os logs.`,
          parse_mode: 'Markdown'
        });
      }
    } catch (e) { console.error('Error notifying admin', e); }
  }

  // Update job status
  if (job.schedule_type !== 'recurring') {
    await db.runAsync(
      "UPDATE scheduled_jobs SET status = ? WHERE id = ?",
      [allOk ? 'done' : 'failed', jobId]
    );
    await db.runAsync("UPDATE campaigns SET status = 'sent', updated_at = datetime('now') WHERE id = ?", [campaign.id]);
  } else {
    // Compute next_run_at for display
    let nextRunDate = new Date();
    try {
      const interval = cronParser.parseExpression(job.cron_expr);
      nextRunDate = interval.next().toDate();
    } catch (e) {
      nextRunDate = new Date(Date.now() + 60000); // fallback 1 min
    }
    await db.runAsync("UPDATE scheduled_jobs SET status = 'pending', next_run_at = ? WHERE id = ?", [nextRunDate.toISOString(), jobId]);
  }
}

async function scheduleJob(jobId) {
  const job = await db.getAsync('SELECT * FROM scheduled_jobs WHERE id = ?', [jobId]);
  if (!job) return;

  if (job.schedule_type === 'immediate') {
    await dispatchJob(jobId);
  } else if (job.schedule_type === 'once') {
    const runAt = new Date(job.run_at);
    const now = new Date();
    const delay = runAt - now;
    if (delay <= 0) {
      await dispatchJob(jobId);
    } else {
      setTimeout(() => dispatchJob(jobId), delay);
    }
  } else if (job.schedule_type === 'recurring') {
    if (!cron.validate(job.cron_expr)) {
      console.error(`Invalid cron expression: ${job.cron_expr}`);
      await db.runAsync("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?", [jobId]);
      await db.runAsync("UPDATE campaigns SET status = 'failed', updated_at = datetime('now') WHERE id = ?", [job.campaign_id]);
      return;
    }
    const task = cron.schedule(job.cron_expr, () => dispatchJob(jobId));
    activeCronJobs[jobId] = task;
  }
}

async function cancelJob(jobId) {
  if (activeCronJobs[jobId]) {
    activeCronJobs[jobId].stop();
    delete activeCronJobs[jobId];
  }
  await db.runAsync("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
}

async function restorePendingJobs() {
  const jobs = await db.allAsync(
    "SELECT * FROM scheduled_jobs WHERE status IN ('pending', 'running')"
  );
  console.log(`Restoring ${jobs.length} pending/running jobs...`);
  for (const job of jobs) {
    if (job.schedule_type === 'recurring') {
      await scheduleJob(job.id);
    } else if (job.schedule_type === 'once') {
      const runAt = new Date(job.run_at);
      if (runAt > new Date()) {
        await scheduleJob(job.id);
      } else {
        // Missed — run now
        await dispatchJob(job.id);
      }
    }
  }
}

module.exports = { scheduleJob, cancelJob, restorePendingJobs, dispatchJob };
