const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const { getUploadLimit, getApiUrl, deleteMessageFromChannel } = require('../bot');
const courses = require('../courses');

const MAX_FILE = courses.MAX_FILE;

const EDITABLE_FIELDS = ['name', 'description', 'channel_id', 'caption_template', 'hashtag_prefix',
  'send_index', 'pin_index', 'protect_content', 'delete_after_upload', 'delay_seconds', 'signature'];

function pickFields(body) {
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (!(key in body)) continue;
    let value = body[key];
    if (['send_index', 'pin_index', 'protect_content', 'delete_after_upload'].includes(key)) value = value ? 1 : 0;
    if (key === 'delay_seconds') value = Math.min(Math.max(parseInt(value, 10) || 3, 1), 120);
    if (typeof value === 'string') value = value.trim();
    if (key === 'channel_id' && !value) value = null;
    if (key === 'signature') value = String(value || '').slice(0, 200);
    out[key] = value;
  }
  return out;
}

async function getCourse(id) {
  return db.getAsync(`
    SELECT co.*, ch.name AS channel_name, ch.username AS channel_username, ch.chat_id AS channel_chat_id
    FROM courses co LEFT JOIN channels ch ON ch.id = co.channel_id
    WHERE co.id = ?`, [id]);
}

// Files can't change under a running upload: positions and numbering would shift mid-send
async function requireEditable(req, res) {
  const course = await getCourse(req.params.id);
  if (!course) { res.status(404).json({ error: 'Curso não encontrado' }); return null; }
  if (course.status === 'running') { res.status(409).json({ error: 'Pause o envio antes de mudar os arquivos' }); return null; }
  return course;
}

// GET /api/courses/info — upload limit and server import folders for the UI
router.get('/info', async (req, res) => {
  try {
    res.json({
      upload_limit: await getUploadLimit(),
      local_api: !!(await getApiUrl()),
      ffmpeg: await courses.hasFfmpeg(),
      import_dir: courses.IMPORT_DIR,
      import_folders: courses.listImportFolders(),
      default_template: courses.DEFAULT_TEMPLATE,
      default_signature: courses.DEFAULT_SIGNATURE,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/courses
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(`
      SELECT co.*, ch.name AS channel_name,
        (SELECT COUNT(*) FROM course_items i WHERE i.course_id = co.id AND i.kind = 'lesson') AS lesson_count,
        (SELECT COUNT(*) FROM course_items i WHERE i.course_id = co.id AND i.kind = 'lesson' AND i.status = 'sent') AS sent_count,
        (SELECT COUNT(*) FROM course_items i WHERE i.course_id = co.id AND i.kind = 'lesson' AND i.status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM course_items i WHERE i.course_id = co.id AND i.kind = 'module') AS module_count,
        (SELECT COALESCE(SUM(file_size), 0) FROM course_items i WHERE i.course_id = co.id AND i.kind = 'lesson') AS total_size
      FROM courses co LEFT JOIN channels ch ON ch.id = co.channel_id
      ORDER BY co.updated_at DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses
router.post('/', async (req, res) => {
  try {
    const fields = pickFields(req.body);
    if (!fields.name) return res.status(400).json({ error: 'Dê um nome ao curso' });
    const id = uuidv4();
    await db.runAsync(
      `INSERT INTO courses (id, name, description, channel_id, caption_template, hashtag_prefix, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, fields.name, fields.description || null, fields.channel_id || null,
        fields.caption_template || courses.DEFAULT_TEMPLATE, fields.hashtag_prefix || '',
        'signature' in fields ? fields.signature : courses.DEFAULT_SIGNATURE]
    );
    fs.mkdirSync(courses.courseFilesDir(id), { recursive: true });
    res.json(await getCourse(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/courses/:id — course with its module/lesson tree in send order
router.get('/:id', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    const ctx = await courses.loadContext(course.id);
    const channel = course.channel_id ? { username: course.channel_username, chat_id: course.channel_chat_id } : null;
    const items = ctx.items.map(item => {
      const { moduleTag, lessonTag } = courses.tagsFor(course, item);
      const { folderTag } = courses.tagsFor(course, item);
      return {
        ...item,
        file_path: undefined,
        depth: item.module_key ? item.module_key.split(' / ').length : 0,
        tag: item.kind === 'module' ? folderTag : lessonTag,
        link: item.status === 'sent' ? courses.messageLink(channel, item.telegram_msg_id) : null,
      };
    });
    const firstLesson = ctx.items.find(i => i.kind === 'lesson' && i.status !== 'skipped');
    res.json({
      ...course,
      running: courses.isRunning(course.id),
      index_link: courses.messageLink(channel, course.index_msg_ids),
      sample_caption: firstLesson ? courses.lessonCaption(course, firstLesson, ctx) : null,
      items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/courses/:id
router.put('/:id', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    const fields = pickFields(req.body);
    if ('name' in fields && !fields.name) return res.status(400).json({ error: 'Dê um nome ao curso' });
    const keys = Object.keys(fields);
    if (keys.length) {
      await db.runAsync(
        `UPDATE courses SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        [...keys.map(k => fields[k]), course.id]
      );
    }
    res.json(await getCourse(course.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Streams the raw request body to `tmp`, then calls onDone(size). Replies with an error itself.
function receiveBody(req, res, tmp, maxSize, onDone) {
  const length = parseInt(req.headers['content-length'], 10);
  if (length > maxSize) return res.status(413).json({ error: 'Arquivo maior que 2 GB, o máximo do Telegram para bots' });
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let failed = false;
  const fail = (status, error) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(tmp, () => {});
    if (!res.headersSent) res.status(status).json({ error });
  };
  req.on('data', chunk => {
    received += chunk.length;
    if (received > maxSize) { fail(413, 'Arquivo maior que 2 GB'); req.destroy(); }
  });
  req.on('aborted', () => fail(400, 'Envio interrompido'));
  out.on('error', err => fail(500, err.message));
  out.on('finish', async () => {
    if (failed) return;
    try {
      await onDone(received);
    } catch (e) {
      fs.unlink(tmp, () => {});
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
  req.pipe(out);
}

// PUT /api/courses/:id/files?path=<relative path> — raw file body, streamed straight to disk
// (no multipart: lessons can be gigabytes and the browser sends them one at a time)
router.put('/:id/files', async (req, res) => {
  try {
    const course = await requireEditable(req, res);
    if (!course) return;
    const rel = courses.safeRelPath(req.query.path);
    if (!rel || rel.split('/').some(courses.isIgnoredFile)) return res.status(400).json({ error: 'Arquivo ignorado' });
    const dest = path.join(courses.courseFilesDir(course.id), rel);
    if (!dest.startsWith(courses.courseFilesDir(course.id) + path.sep)) return res.status(400).json({ error: 'Caminho inválido' });

    const tmp = `${dest}.${Date.now()}.part`;
    receiveBody(req, res, tmp, MAX_FILE, async size => {
      fs.renameSync(tmp, dest);
      const id = await courses.addLessonFile(course.id, rel, dest, size, true);
      res.json({ ok: true, id, size });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/courses/:id/zip?folder=<destination> — a .zip of the course, extracted keeping its folders.
// The way to send a whole course from a phone, where browsers can't pick folders.
router.put('/:id/zip', async (req, res) => {
  try {
    const course = await requireEditable(req, res);
    if (!course) return;
    const tmp = path.join(courses.COURSES_DIR, course.id, `upload-${Date.now()}.zip`);
    receiveBody(req, res, tmp, 20 * 1024 * 1024 * 1024, async () => {
      try {
        const result = await courses.extractZip(course.id, tmp, req.query.folder || '');
        await courses.rebuildStructure(course.id);
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(400).json({ error: e.message });
      } finally {
        fs.unlink(tmp, () => {});
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/rebuild — renumber modules/lessons after a batch of uploads
router.post('/:id/rebuild', async (req, res) => {
  try {
    const course = await requireEditable(req, res);
    if (!course) return;
    await courses.rebuildStructure(course.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/import { folder } — use a folder already on the server, without copying it
router.post('/:id/import', async (req, res) => {
  try {
    const course = await requireEditable(req, res);
    if (!course) return;
    const root = courses.resolveImportFolder(req.body.folder);
    if (!root) return res.status(400).json({ error: 'Pasta não encontrada' });
    const files = courses.scanFolder(root);
    if (!files.length) return res.status(400).json({ error: 'A pasta está vazia' });
    for (const f of files) await courses.addLessonFile(course.id, f.relPath, f.filePath, f.size, false);
    await courses.rebuildStructure(course.id);
    res.json({ ok: true, imported: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/courses/:id/items/:itemId { title?, skip? }
router.put('/:id/items/:itemId', async (req, res) => {
  try {
    const item = await db.getAsync('SELECT * FROM course_items WHERE id = ? AND course_id = ?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim();
      if (!title) return res.status(400).json({ error: 'O título não pode ficar vazio' });
      await db.runAsync('UPDATE course_items SET title = ? WHERE id = ?', [title.slice(0, 500), item.id]);
    }
    if (typeof req.body.folder === 'string') {
      if (item.kind !== 'lesson') return res.status(400).json({ error: 'Só aulas podem ser movidas' });
      if (item.status === 'sent' || item.status === 'sending') return res.status(400).json({ error: 'Essa aula já foi enviada' });
      const course = await getCourse(req.params.id);
      if (course.status === 'running') return res.status(409).json({ error: 'Pause o envio antes de mover aulas' });
      await courses.moveLesson(item, req.body.folder);
      await courses.rebuildStructure(item.course_id);
    }
    if (typeof req.body.skip === 'boolean') {
      if (item.status === 'sent' || item.status === 'sending') return res.status(400).json({ error: 'Essa aula já foi enviada' });
      await db.runAsync('UPDATE course_items SET status = ? WHERE id = ?', [req.body.skip ? 'skipped' : 'pending', item.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/courses/:id/items/:itemId — removes a lesson (and its uploaded file)
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    const course = await requireEditable(req, res);
    if (!course) return;
    const item = await db.getAsync("SELECT * FROM course_items WHERE id = ? AND course_id = ? AND kind = 'lesson'", [req.params.itemId, course.id]);
    if (!item) return res.status(404).json({ error: 'Aula não encontrada' });
    await db.runAsync('DELETE FROM course_items WHERE id = ?', [item.id]);
    if (item.owned && item.file_path) fs.unlink(item.file_path, () => {});
    await courses.rebuildStructure(course.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/start — also resumes a paused upload
router.post('/:id/start', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    if (!course.channel_id) return res.status(400).json({ error: 'Escolha o canal de destino' });
    if (course.status !== 'running') await courses.rebuildStructure(course.id);
    const pending = await db.getAsync("SELECT COUNT(*) AS n FROM course_items WHERE course_id = ? AND status IN ('pending', 'sending')", [course.id]);
    if (!pending.n) return res.status(400).json({ error: 'Não há aulas pendentes para enviar' });
    await courses.startCourse(course.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/pause
router.post('/:id/pause', async (req, res) => {
  try {
    await courses.pauseCourse(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/retry — failed lessons go back to the queue
router.post('/:id/retry', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    const result = await db.runAsync("UPDATE course_items SET status = 'pending', error_msg = NULL WHERE course_id = ? AND status = 'failed'", [course.id]);
    if (!result.changes) return res.status(400).json({ error: 'Nenhuma aula com falha' });
    await courses.startCourse(course.id);
    res.json({ ok: true, retried: result.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/courses/:id/index — (re)posts the index with links to every lesson
router.post('/:id/index', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    if (course.status === 'running') return res.status(409).json({ error: 'Espere o envio terminar' });
    const result = await courses.postIndex(course.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/courses/:id?telegram=1 — telegram=1 also deletes the posts from the channel
router.delete('/:id', async (req, res) => {
  try {
    const course = await getCourse(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso não encontrado' });
    await courses.pauseCourse(course.id);

    let deleteErrors = 0;
    if (req.query.telegram === '1' && course.channel_chat_id) {
      const sent = await db.allAsync("SELECT telegram_msg_id FROM course_items WHERE course_id = ? AND telegram_msg_id IS NOT NULL", [course.id]);
      const ids = [course.intro_msg_id, course.index_msg_ids, ...sent.map(s => s.telegram_msg_id)]
        .filter(id => id && id !== '0');
      for (const id of ids) {
        const result = await deleteMessageFromChannel(course.channel_chat_id, id).catch(e => ({ ok: false, error: e.message }));
        if (!result.ok) deleteErrors++;
      }
    }

    await db.runAsync('DELETE FROM course_items WHERE course_id = ?', [course.id]);
    await db.runAsync('DELETE FROM courses WHERE id = ?', [course.id]);
    fs.rm(path.join(courses.COURSES_DIR, course.id), { recursive: true, force: true }, () => {});
    res.json({ ok: true, delete_errors: deleteErrors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
