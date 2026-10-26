const cron = require('node-cron');
const { CronExpressionParser } = require('cron-parser');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { sendCampaignToChannel } = require('./bot');

const activeCronJobs = {};   // jobId -> cron task
const cancelledJobs = new Set(); // jobIds requested to cancel mid-run
const MAX_TIMEOUT = 2147483647; // largest delay setTimeout accepts (~24.8 days)
// Recurring campaigns run on this timezone, not the server's (Docker images default to UTC)
const CRON_TZ = process.env.CRON_TZ || 'America/Sao_Paulo';

function nextCronRun(cronExpr) {
  try {
    return CronExpressionParser.parse(cronExpr, { tz: CRON_TZ }).next().toDate();
  } catch (e) {
    return null;
  }
}

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
  let cancelled = false;
  for (const ch of channels) {
    // Check if a cancellation was requested
    if (cancelledJobs.has(jobId)) {
      cancelledJobs.delete(jobId);
      cancelled = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay per channel
    const logId = uuidv4();
    try {
      const res = await sendCampaignToChannel(ch.chat_id, campaign);
      await db.runAsync(`
        INSERT INTO send_log (id, job_id, campaign_id, channel_id, channel_name, status, telegram_msg_id)
        VALUES (?, ?, ?, ?, ?, 'success', ?)
      `, [logId, jobId, campaign.id, ch.id, ch.name, (res.message_ids || [res.message_id]).filter(Boolean).join(',')]);
    } catch (err) {
      allOk = false;
      await db.runAsync(`
        INSERT INTO send_log (id, job_id, campaign_id, channel_id, channel_name, status, error_msg)
        VALUES (?, ?, ?, ?, ?, 'failed', ?)
      `, [logId, jobId, campaign.id, ch.id, ch.name, err.message]);
    }
  }

  // If cancelled mid-run, mark as cancelled and return early
  if (cancelled) {
    await db.runAsync("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
    await db.runAsync("UPDATE campaigns SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", [campaign.id]);
    return;
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
    const nextRunDate = nextCronRun(job.cron_expr) || new Date(Date.now() + 60000); // fallback 1 min
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
    } else if (delay > MAX_TIMEOUT) {
      // setTimeout overflows above ~24.8 days and fires immediately, so wait in steps
      setTimeout(() => scheduleJob(jobId).catch(console.error), MAX_TIMEOUT);
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
    const task = cron.schedule(job.cron_expr, () => dispatchJob(jobId), { timezone: CRON_TZ });
    activeCronJobs[jobId] = task;
    const nextRun = nextCronRun(job.cron_expr);
    if (nextRun) await db.runAsync('UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?', [nextRun.toISOString(), jobId]);
  }
}

async function cancelJob(jobId) {
  if (activeCronJobs[jobId]) {
    activeCronJobs[jobId].stop();
    delete activeCronJobs[jobId];
  }
  // Signal cancellation for jobs currently running mid-loop
  cancelledJobs.add(jobId);
  await db.runAsync("UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
}

// Request cancellation of a running dispatch (mid-loop)
function requestCancel(jobId) {
  cancelledJobs.add(jobId);
}

async function restorePendingJobs() {
  // Reset any jobs that were 'running' when the server shut down — they were interrupted
  const stuckJobs = await db.allAsync("SELECT * FROM scheduled_jobs WHERE status = 'running'");
  for (const job of stuckJobs) {
    console.log(`Resetting stuck running job ${job.id} to failed (server was restarted)`);
    await db.runAsync("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?", [job.id]);
    await db.runAsync("UPDATE campaigns SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'running'", [job.campaign_id]);
  }

  const jobs = await db.allAsync(
    "SELECT * FROM scheduled_jobs WHERE status = 'pending'"
  );
  console.log(`Restoring ${jobs.length} pending jobs...`);
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

// Auto-delete cron: runs every 30 minutes, deletes messages for campaigns with auto_delete_hours set
async function runAutoDelete() {
  try {
    const { deleteMessageFromChannel } = require('./bot');

    // Per message, counted from when it was sent. Works for recurring campaigns too
    // (their status stays 'scheduled'), and editing a campaign doesn't postpone deletion.
    const logs = await db.allAsync(`
      SELECT sl.id, sl.campaign_id, sl.telegram_msg_id, ch.chat_id
      FROM send_log sl
      JOIN campaigns c ON c.id = sl.campaign_id
      JOIN channels ch ON ch.id = sl.channel_id
      WHERE c.auto_delete_hours IS NOT NULL
        AND sl.status = 'success'
        AND sl.telegram_msg_id IS NOT NULL AND sl.telegram_msg_id != ''
        AND sl.sent_at <= datetime('now', '-' || c.auto_delete_hours || ' hours')
    `);
    if (logs.length === 0) return;

    const touched = new Set();
    let deletedCount = 0;
    for (const log of logs) {
      touched.add(log.campaign_id);
      const result = await deleteMessageFromChannel(log.chat_id, log.telegram_msg_id);
      if (result.ok) {
        deletedCount++;
        await db.runAsync("UPDATE send_log SET status = 'deleted' WHERE id = ?", [log.id]);
      } else {
        // Recorded so it isn't retried every 30 minutes; it can still be retried from the panel
        await db.runAsync("UPDATE send_log SET status = 'failed_delete', error_msg = ? WHERE id = ?", [result.error || 'Falha ao apagar', log.id]);
      }
    }

    // One-off campaigns with nothing left on Telegram are marked as deleted
    for (const campaignId of touched) {
      const remaining = await db.getAsync(
        "SELECT COUNT(*) as n FROM send_log WHERE campaign_id = ? AND status IN ('success', 'failed_delete')",
        [campaignId]
      );
      if (remaining.n === 0) {
        await db.runAsync(
          "UPDATE campaigns SET status = 'deleted', updated_at = datetime('now') WHERE id = ? AND status = 'sent'",
          [campaignId]
        );
      }
    }
    console.log(`Auto-delete: ${deletedCount}/${logs.length} messages deleted`);
  } catch (e) {
    console.error('Auto-delete cron error:', e.message);
  }
}

function startAutoDeleteCron() {
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', () => runAutoDelete());
  console.log('Auto-delete cron started (runs every 30 minutes)');
}

module.exports = { runAutoDelete, nextCronRun, scheduleJob, cancelJob, restorePendingJobs, dispatchJob, requestCancel, startAutoDeleteCron };
