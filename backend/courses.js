// Course uploader: turns a folder of lessons into an organized Telegram channel
// (module headers, hashtags, a linked index) and sends it as a resumable queue.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const yauzl = require('yauzl');
const { getBot, getUploadLimit, deleteMessageFromChannel } = require('./bot');

const COURSES_DIR = path.join(__dirname, 'data', 'courses');
// Folder on the server where large courses can be dropped (SFTP, rclone…) and imported in place
const IMPORT_DIR = path.resolve(process.env.COURSES_IMPORT_DIR || path.join(__dirname, 'data', 'import'));
for (const dir of [COURSES_DIR, IMPORT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_TEMPLATE = '🎬 <b>{aula}</b>\n📂 {caminho}\n\n#{tag_modulo} #{tag_pasta} #{tag}';
const DEFAULT_SIGNATURE = process.env.COURSE_SIGNATURE || '@mestredoscursoss';
const MAX_FILE = 2000 * 1024 * 1024; // Bot API maximum, even with a local server
const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;
const PHOTO_LIMIT = 10 * 1024 * 1024; // larger images go as documents

const EXT_TYPES = {
  video: ['mp4', 'm4v', 'mov'],
  photo: ['jpg', 'jpeg', 'png', 'webp'],
  audio: ['mp3', 'm4a', 'ogg', 'oga', 'wav', 'flac', 'aac'],
};
const IGNORED_EXT = ['url', 'lnk', 'ini', 'part', 'crdownload', 'tmp'];

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const running = new Set(); // course ids with an active send loop

function courseFilesDir(courseId) {
  return path.join(COURSES_DIR, courseId, 'files');
}

function isIgnoredFile(name) {
  const lower = name.toLowerCase();
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  if (['thumbs.db', 'desktop.ini'].includes(lower)) return true;
  return IGNORED_EXT.includes(path.extname(lower).slice(1));
}

function mediaTypeFor(fileName, size) {
  const ext = path.extname(fileName).toLowerCase().slice(1);
  if (EXT_TYPES.video.includes(ext)) return 'video';
  if (EXT_TYPES.photo.includes(ext)) return size > PHOTO_LIMIT ? 'document' : 'photo';
  if (EXT_TYPES.audio.includes(ext)) return 'audio';
  return 'document';
}

// "Modulo 1/02_Instalação.mp4" → "02 Instalação"
function cleanTitle(fileName) {
  return path.basename(fileName, path.extname(fileName)).replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || fileName;
}

// Normalizes a client-supplied relative path, dropping anything that could escape the course folder
// NFC: macOS writes accents decomposed ("o" + "´"), which would make "Módulo" two different folders
function safeRelPath(rel) {
  const parts = String(rel || '').normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .map(p => p.replace(/[\x00-\x1f]/g, '').trim())
    .filter(p => p && p !== '.' && p !== '..');
  return parts.join('/');
}

function moduleKeyOf(relPath) {
  return relPath.split('/').slice(0, -1).join(' / ');
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function visibleLength(html) {
  return html.replace(/<[^>]*>/g, '').length;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = n => String(n).padStart(2, '0');

// ── Structure ──────────────────────────────────────────────────────────

async function addLessonFile(courseId, relPath, filePath, size, owned = true) {
  const existing = await db.getAsync(
    "SELECT * FROM course_items WHERE course_id = ? AND kind = 'lesson' AND rel_path = ?",
    [courseId, relPath]
  );
  const mediaType = mediaTypeFor(relPath, size);
  if (existing) {
    // Re-uploading a file replaces it, unless it is already on Telegram
    if (existing.status === 'sent') return existing.id;
    await db.runAsync(
      "UPDATE course_items SET file_path = ?, file_size = ?, media_type = ?, owned = ?, status = 'pending', error_msg = NULL WHERE id = ?",
      [filePath, size, mediaType, owned ? 1 : 0, existing.id]
    );
    return existing.id;
  }
  const id = uuidv4();
  await db.runAsync(
    `INSERT INTO course_items (id, course_id, kind, module_key, rel_path, title, file_path, file_size, media_type, owned)
     VALUES (?, ?, 'lesson', ?, ?, ?, ?, ?, ?, ?)`,
    [id, courseId, moduleKeyOf(relPath), relPath, cleanTitle(relPath), filePath, size, mediaType, owned ? 1 : 0]
  );
  return id;
}

// Path-aware natural order: compares folder by folder, so each folder's content stays together
// and "Aula 2" comes before "Aula 10"
function comparePaths(a, b) {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = collator.compare(pa[i], pb[i]);
    if (c) return c;
  }
  return pa.length - pb.length;
}

// Recomputes folder headers, numbering and send order. Folders nest to any depth:
// "Módulo 1/Parte A/Extra/aula.mp4" gets headers for Módulo 1 (1), Parte A (1.1) and Extra (1.1.1).
async function rebuildStructure(courseId) {
  const items = await db.allAsync('SELECT * FROM course_items WHERE course_id = ?', [courseId]);
  const lessons = items.filter(i => i.kind === 'lesson').sort((a, b) => comparePaths(a.rel_path, b.rel_path));
  const headers = new Map(items.filter(i => i.kind === 'module').map(m => [m.module_key, m]));

  const updates = [];
  const numPaths = new Map([['', '']]);  // folder key -> "1.2"
  const subfolderCount = new Map();      // parent key -> subfolders numbered so far
  const lessonCount = new Map();         // folder key -> lessons numbered so far
  let position = 0;

  for (const lesson of lessons) {
    const dirs = lesson.module_key ? lesson.module_key.split(' / ') : [];
    // Headers for every folder on the way down, the first time the folder shows up
    for (let depth = 1; depth <= dirs.length; depth++) {
      const key = dirs.slice(0, depth).join(' / ');
      if (numPaths.has(key)) continue;
      const parent = dirs.slice(0, depth - 1).join(' / ');
      const n = (subfolderCount.get(parent) || 0) + 1;
      subfolderCount.set(parent, n);
      const numPath = numPaths.get(parent) ? `${numPaths.get(parent)}.${n}` : String(n);
      numPaths.set(key, numPath);

      let header = headers.get(key);
      if (!header) {
        header = { id: uuidv4() };
        updates.push(["INSERT INTO course_items (id, course_id, kind, module_key, title) VALUES (?, ?, 'module', ?, ?)",
          [header.id, courseId, key, dirs[depth - 1]]]);
      }
      headers.delete(key);
      updates.push(['UPDATE course_items SET position = ?, module_num = ?, num_path = ?, lesson_num = NULL WHERE id = ?',
        [position++, Number(numPath.split('.')[0]), numPath, header.id]]);
    }
    const key = lesson.module_key || '';
    const lessonNum = (lessonCount.get(key) || 0) + 1;
    lessonCount.set(key, lessonNum);
    const numPath = numPaths.get(key) || '';
    updates.push(['UPDATE course_items SET position = ?, module_num = ?, num_path = ?, lesson_num = ? WHERE id = ?',
      [position++, numPath ? Number(numPath.split('.')[0]) : 0, numPath, lessonNum, lesson.id]]);
  }
  // Headers left without lessons: drop them unless they're already on the channel
  for (const header of headers.values()) {
    if (header.status === 'sent') updates.push(['UPDATE course_items SET position = ? WHERE id = ?', [position++, header.id]]);
    else updates.push(['DELETE FROM course_items WHERE id = ?', [header.id]]);
  }

  await db.runAsync('BEGIN');
  try {
    for (const [sql, params] of updates) await db.runAsync(sql, params);
    await db.runAsync('COMMIT');
  } catch (e) {
    await db.runAsync('ROLLBACK').catch(() => {});
    throw e;
  }
  await db.runAsync("UPDATE courses SET updated_at = datetime('now') WHERE id = ?", [courseId]);
}

// Moves a lesson to another folder ("" = course root). The file stays where it is on disk.
async function moveLesson(item, folder) {
  const dir = safeRelPath(folder);
  const base = path.basename(item.rel_path);
  const ext = path.extname(base);
  let rel = dir ? `${dir}/${base}` : base;
  // Two files can't share a path: "Aula.mp4" becomes "Aula (2).mp4"
  for (let n = 2; await db.getAsync("SELECT 1 FROM course_items WHERE course_id = ? AND kind = 'lesson' AND rel_path = ? AND id != ?", [item.course_id, rel, item.id]); n++) {
    const renamed = `${path.basename(base, ext)} (${n})${ext}`;
    rel = dir ? `${dir}/${renamed}` : renamed;
  }
  await db.runAsync('UPDATE course_items SET rel_path = ?, module_key = ? WHERE id = ?', [rel, moduleKeyOf(rel), item.id]);
}

// Upper half of code page 437, the encoding ZIP tools use for names not flagged as UTF-8
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

// Many zippers (macOS Finder, Info-ZIP) store UTF-8 names without setting the UTF-8 flag,
// so names that are valid UTF-8 are read as such and only the rest falls back to CP437
function decodeZipName(entry) {
  const buf = entry.fileName;
  if (typeof buf === 'string') return buf;
  if (entry.generalPurposeBitFlag & 0x800) return buf.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return [...buf].map(b => (b < 128 ? String.fromCharCode(b) : CP437[b - 128])).join('');
  }
}

// Extracts a .zip of the course, keeping its folders. A single top folder wrapping everything
// ("Meu Curso/Módulo 1/…") is the course itself and is dropped, like when picking the folder.
function extractZip(courseId, zipPath, destFolder = '') {
  const dest = safeRelPath(destFolder);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: false }, (err, zip) => {
      if (err) return reject(new Error('Arquivo .zip inválido ou corrompido'));
      const entries = [];
      zip.on('error', e => reject(e));
      zip.on('entry', entry => {
        const name = decodeZipName(entry).normalize('NFC').replace(/\\/g, '/');
        const parts = name.split('/').filter(Boolean);
        const isDir = name.endsWith('/');
        if (!isDir && parts.length && parts[0] !== '__MACOSX' && !parts.some(isIgnoredFile)) entries.push({ entry, parts });
        zip.readEntry();
      });
      zip.on('end', async () => {
        try {
          const tops = new Set(entries.map(e => (e.parts.length > 1 ? e.parts[0] : null)));
          const stripTop = tops.size === 1 && !tops.has(null);
          let added = 0;
          const skipped = [];
          for (const { entry, parts } of entries) {
            const rel = safeRelPath([dest, ...(stripTop ? parts.slice(1) : parts)].filter(Boolean).join('/'));
            if (!rel) continue;
            if (entry.uncompressedSize > MAX_FILE) { skipped.push(`${rel}: maior que 2 GB`); continue; }
            const target = path.join(courseFilesDir(courseId), rel);
            if (!target.startsWith(courseFilesDir(courseId) + path.sep)) continue;
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await new Promise((res, rej) => zip.openReadStream(entry, (e, stream) => {
              if (e) return rej(e);
              const out = fs.createWriteStream(target);
              stream.on('error', rej);
              out.on('error', rej);
              out.on('finish', res);
              stream.pipe(out);
            }));
            await addLessonFile(courseId, rel, target, fs.statSync(target).size, true);
            added++;
          }
          zip.close();
          resolve({ added, skipped });
        } catch (e) {
          zip.close();
          reject(e);
        }
      });
      zip.readEntry();
    });
  });
}

// Lists files under a folder of IMPORT_DIR as [{ relPath, filePath, size }]
function scanFolder(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnoredFile(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, childRel);
      else if (entry.isFile()) out.push({ relPath: childRel, filePath: full, size: fs.statSync(full).size });
    }
  };
  walk(root, '');
  return out;
}

function listImportFolders() {
  return fs.readdirSync(IMPORT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort(collator.compare);
}

function resolveImportFolder(name) {
  const full = path.resolve(IMPORT_DIR, safeRelPath(name));
  if (!full.startsWith(IMPORT_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) return null;
  return full;
}

// ── Captions and links ─────────────────────────────────────────────────

function hashtagPrefix(course) {
  const p = String(course.hashtag_prefix || '').replace(/[^\p{L}\p{N}_]/gu, '');
  return p ? `${p}_` : '';
}

// "1.2.3" → "M01S02S03": M for the module, S for each level of subfolder
function folderTagOf(prefix, numPath) {
  if (!numPath) return '';
  return prefix + numPath.split('.').map((n, i) => (i === 0 ? 'M' : 'S') + pad(n)).join('');
}

function tagsFor(course, item) {
  const p = hashtagPrefix(course);
  const numPath = item.num_path || (item.module_num ? String(item.module_num) : '');
  const moduleTag = folderTagOf(p, numPath.split('.')[0]);
  const folderTag = folderTagOf(p, numPath);
  const lessonTag = item.kind === 'lesson' && item.lesson_num ? `${folderTag || p}A${pad(item.lesson_num)}` : '';
  return { moduleTag, folderTag, lessonTag };
}

// Fills {variables}. A line whose variables are all empty is dropped, "#{var}" disappears with an
// empty var, and a hashtag repeated on a line is kept once (#M01 #M01 when the lesson is right in the module).
function renderTemplate(template, vars) {
  const lines = template.split('\n').map(line => {
    let used = 0;
    let filled = 0;
    let out = line.replace(/(#?)\{(\w+)\}/g, (match, hash, name) => {
      if (!(name in vars)) return match;
      used++;
      const value = vars[name];
      if (value === '' || value == null) return '';
      filled++;
      return hash + escapeHtml(value);
    });
    if (used > 0 && filled === 0) return null;
    const seen = new Set();
    out = out.replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, (m, space, tag) => (seen.has(tag) ? space : (seen.add(tag), m)));
    // Empty variables can leave doubled or edge spaces
    return used > filled || out !== line ? out.replace(/ {2,}/g, ' ').trim() : out.replace(/\s+$/, '');
  });
  return lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Folder titles from the top down, using the (renamable) header titles
function folderTitles(ctx, key) {
  if (!key) return [];
  const dirs = key.split(' / ');
  return dirs.map((dir, i) => {
    const header = ctx.headers.get(dirs.slice(0, i + 1).join(' / '));
    return header ? header.title : dir;
  });
}

function withSignature(course, html) {
  const sig = String(course.signature || '').trim();
  return sig ? `${html}\n\n${escapeHtml(sig)}` : html;
}

function lessonCaption(course, item, ctx) {
  const { moduleTag, folderTag, lessonTag } = tagsFor(course, item);
  const titles = folderTitles(ctx, item.module_key);
  const vars = {
    curso: course.name,
    modulo: titles[0] || '',
    pasta: titles[titles.length - 1] || '',
    caminho: titles.join(' › '),
    aula: item.title,
    n_modulo: item.module_num || '',
    n_aula: item.lesson_num,
    n: ctx.lessonIndex.get(item.id) || '',
    total: ctx.totalLessons,
    tag: lessonTag,
    tag_modulo: moduleTag,
    tag_pasta: folderTag,
    arquivo: path.basename(item.rel_path || ''),
  };
  const caption = withSignature(course, renderTemplate(course.caption_template || DEFAULT_TEMPLATE, vars));
  if (visibleLength(caption) <= CAPTION_LIMIT) return caption;
  return withSignature(course, `<b>${escapeHtml(item.title.slice(0, 800))}</b>\n\n#${lessonTag}`);
}

function moduleCaption(course, header, ctx) {
  const { moduleTag, folderTag } = tagsFor(course, header);
  const tags = [...new Set([moduleTag, folderTag])].map(t => `#${t}`).join(' ');
  const count = ctx.subtreeCount(header.module_key);
  const lessons = `🎬 ${count} ${count === 1 ? 'aula' : 'aulas'}`;
  const parents = folderTitles(ctx, header.module_key).slice(0, -1);
  if (!parents.length) return `📂 <b>${escapeHtml(header.title)}</b>\n${lessons}\n\n${tags}`;
  return `📁 <b>${escapeHtml(header.title)}</b>\n<i>${escapeHtml(parents.join(' › '))}</i>\n${lessons}\n\n${tags}`;
}

// t.me link to a channel post: public channels by username, private ones by internal id (members only)
function messageLink(channel, messageId) {
  if (!channel || !messageId) return null;
  const id = String(messageId).split(',')[0];
  if (channel.username) return `https://t.me/${channel.username.replace(/^@/, '')}/${id}`;
  const chatId = String(channel.chat_id);
  if (chatId.startsWith('-100')) return `https://t.me/c/${chatId.slice(4)}/${id}`;
  return null;
}

const INDENT = ' '; // em space: Telegram keeps it at the start of a line

// Splits the index into messages under Telegram's 4096-character limit, never breaking a line.
// Subfolders are indented under their module; the signature closes the last message.
function buildIndexMessages(course, channel, items) {
  const lines = [`📚 <b>${escapeHtml(course.name)}</b> — Sumário`, ''];
  for (const item of items) {
    if (item.status === 'skipped') continue;
    const depth = item.module_key ? item.module_key.split(' / ').length : 0;
    const link = item.status === 'sent' ? messageLink(channel, item.telegram_msg_id) : null;
    if (item.kind === 'module') {
      const title = `<b>${escapeHtml(item.title)}</b>`;
      const label = link ? `<a href="${link}">${title}</a>` : title;
      if (depth === 1) lines.push(...(lines[lines.length - 1] === '' ? [] : ['']), `📂 ${label}`);
      else lines.push(`${INDENT.repeat(depth - 1)}📁 ${label}`);
    } else {
      const title = escapeHtml(item.title);
      lines.push(`${INDENT.repeat(depth)}• ${link ? `<a href="${link}">${title}</a>` : title}`);
    }
  }
  const sig = String(course.signature || '').trim();
  if (sig) lines.push('', escapeHtml(sig));

  const messages = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (visibleLength(next) > MESSAGE_LIMIT - 50 || next.length > MESSAGE_LIMIT * 3) {
      messages.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

// ── Video metadata (optional, needs ffmpeg) ────────────────────────────

let ffmpegAvailable = null;
function hasFfmpeg() {
  if (ffmpegAvailable !== null) return Promise.resolve(ffmpegAvailable);
  return new Promise(resolve => {
    execFile('ffprobe', ['-version'], err => {
      ffmpegAvailable = !err;
      resolve(ffmpegAvailable);
    });
  });
}

function probeVideo(filePath) {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', filePath],
      { timeout: 60000 }, (err, stdout) => {
        if (err) return resolve({});
        try {
          const data = JSON.parse(stdout);
          const stream = (data.streams || [])[0] || {};
          const duration = Math.round(Number(data.format && data.format.duration) || 0);
          resolve({ width: stream.width, height: stream.height, duration: duration || undefined });
        } catch (_) { resolve({}); }
      });
  });
}

// Telegram wants a JPEG thumbnail of at most 320px and 200 KB
function makeThumbnail(filePath, courseId, itemId, duration) {
  const dir = path.join(COURSES_DIR, courseId, 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${itemId}.jpg`);
  const at = duration && duration > 10 ? Math.min(Math.round(duration * 0.1), 60) : 1;
  return new Promise(resolve => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', filePath, '-frames:v', '1',
      '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '6', out],
      { timeout: 60000 }, err => resolve(!err && fs.existsSync(out) ? out : null));
  });
}

// ── Sending ────────────────────────────────────────────────────────────

async function sendLessonFile(bot, chatId, course, item, caption, parseMode) {
  const base = {
    ...(caption ? { caption } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(course.protect_content ? { protect_content: true } : {}),
  };
  const fileOptions = { filename: path.basename(item.file_path) };
  const stream = () => fs.createReadStream(item.file_path);

  if (item.media_type === 'video') {
    const extra = { supports_streaming: true };
    let thumb = null;
    if (await hasFfmpeg()) {
      const meta = await probeVideo(item.file_path);
      Object.assign(extra, Object.fromEntries(Object.entries(meta).filter(([, v]) => v)));
      thumb = await makeThumbnail(item.file_path, course.id, item.id, meta.duration);
    }
    // Built by hand so the thumbnail goes as an attachment (the library would put its path in the query string)
    const [formData] = bot._formatSendData('video', stream(), fileOptions);
    const qs = { chat_id: chatId, ...base, ...extra };
    if (thumb) {
      formData.thumbnail = { value: fs.createReadStream(thumb), options: { filename: 'thumb.jpg', contentType: 'image/jpeg' } };
      qs.thumbnail = 'attach://thumbnail';
    }
    try {
      return await bot._request('sendVideo', { qs, formData });
    } finally {
      if (thumb) fs.unlink(thumb, () => {});
    }
  }
  if (item.media_type === 'photo') return bot.sendPhoto(chatId, stream(), base, fileOptions);
  if (item.media_type === 'audio') return bot.sendAudio(chatId, stream(), { ...base, title: item.title }, fileOptions);
  return bot.sendDocument(chatId, stream(), base, fileOptions);
}

function telegramError(err) {
  const body = err && err.response && err.response.body;
  return {
    status: err && err.response ? err.response.statusCode : null,
    retryAfter: body && body.parameters && body.parameters.retry_after,
    message: (body && body.description) || (err && err.message) || String(err),
  };
}

// Errors that will hit every lesson the same way: pause instead of failing the whole course
function isFatal({ status, message }) {
  return status === 401 || status === 403 || /chat not found|bot was kicked|not enough rights|need administrator rights/i.test(message);
}

// Runs fn, waiting out rate limits (429) and retrying network errors
async function withRetry(fn) {
  let networkAttempts = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const info = telegramError(err);
      if (info.status === 429) {
        await sleep(((info.retryAfter || 5) + 1) * 1000);
        continue;
      }
      if (!info.status && networkAttempts < 3) {
        networkAttempts++;
        await sleep(10000 * networkAttempts);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Limite de tentativas atingido (Telegram pedindo para esperar repetidamente)');
}

async function sendHtml(bot, chatId, course, text) {
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...(course.protect_content ? { protect_content: true } : {}) };
  return withRetry(() => bot.sendMessage(chatId, text, opts));
}

async function loadContext(courseId) {
  const items = await db.allAsync('SELECT * FROM course_items WHERE course_id = ? ORDER BY position', [courseId]);
  const headers = new Map(items.filter(i => i.kind === 'module').map(m => [m.module_key, m]));
  const lessons = items.filter(i => i.kind === 'lesson' && i.status !== 'skipped');
  const lessonIndex = new Map(lessons.map((l, i) => [l.id, i + 1]));
  // Lessons inside a folder, its subfolders included
  const subtreeCount = key => lessons.filter(l => l.module_key === key || (l.module_key || '').startsWith(key + ' / ')).length;
  return { items, headers, lessonIndex, subtreeCount, totalLessons: lessons.length };
}

async function sendItem(bot, chatId, course, item, ctx, uploadLimit) {
  if (item.kind === 'module') {
    const msg = await sendHtml(bot, chatId, course, moduleCaption(course, item, ctx));
    return String(msg.message_id);
  }
  if (!item.file_path || !fs.existsSync(item.file_path)) throw new Error('Arquivo não encontrado no servidor');
  const size = fs.statSync(item.file_path).size;
  if (size > uploadLimit) {
    const mb = Math.round(uploadLimit / 1024 / 1024);
    throw new Error(`Arquivo de ${Math.round(size / 1024 / 1024)} MB passa do limite de ${mb} MB. ` +
      (mb < 100 ? 'Configure um servidor Bot API local para enviar até 2 GB.' : ''));
  }
  const caption = lessonCaption(course, item, ctx);
  try {
    const msg = await withRetry(() => sendLessonFile(bot, chatId, course, item, caption, 'HTML'));
    return String(msg.message_id);
  } catch (err) {
    // A broken HTML tag in the template shouldn't cost the lesson: send it as plain text
    if (!/can't parse entities/i.test(telegramError(err).message)) throw err;
    const msg = await withRetry(() => sendLessonFile(bot, chatId, course, item, caption.replace(/<[^>]*>/g, ''), null));
    return String(msg.message_id);
  }
}

async function postIndex(courseId) {
  const course = await db.getAsync('SELECT * FROM courses WHERE id = ?', [courseId]);
  const channel = course && await db.getAsync('SELECT * FROM channels WHERE id = ?', [course.channel_id]);
  if (!channel) throw new Error('Canal do curso não encontrado');
  const bot = await getBot();
  if (!bot) throw new Error('Bot não configurado');

  // The new index goes to the end of the channel, so the old one is removed
  if (course.index_msg_ids) await deleteMessageFromChannel(channel.chat_id, course.index_msg_ids).catch(() => {});

  const { items } = await loadContext(courseId);
  const ids = [];
  for (const text of buildIndexMessages(course, channel, items)) {
    const msg = await sendHtml(bot, channel.chat_id, course, text);
    ids.push(msg.message_id);
    await sleep(1000);
  }
  await db.runAsync('UPDATE courses SET index_msg_ids = ? WHERE id = ?', [ids.join(','), courseId]);

  let warning = null;
  if (course.pin_index && ids.length) {
    try {
      await bot.pinChatMessage(channel.chat_id, ids[0], { disable_notification: true });
    } catch (e) {
      warning = `Sumário enviado, mas não foi possível fixá-lo: ${telegramError(e).message}`;
    }
  }
  return { message_ids: ids, warning };
}

async function finishCourse(courseId) {
  const course = await db.getAsync('SELECT * FROM courses WHERE id = ?', [courseId]);
  let lastError = null;
  if (course.send_index) {
    try {
      const result = await postIndex(courseId);
      lastError = result.warning;
    } catch (e) {
      lastError = `Falha ao enviar o sumário: ${telegramError(e).message}`;
    }
  }
  await db.runAsync(
    "UPDATE courses SET status = 'done', last_error = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [lastError, courseId]
  );
}

async function pauseWithError(courseId, message) {
  await db.runAsync("UPDATE courses SET status = 'paused', last_error = ?, updated_at = datetime('now') WHERE id = ?", [message, courseId]);
}

async function runCourse(courseId) {
  if (running.has(courseId)) return;
  running.add(courseId);
  try {
    while (true) {
      const course = await db.getAsync('SELECT * FROM courses WHERE id = ?', [courseId]);
      if (!course || course.status !== 'running') return;

      const channel = await db.getAsync('SELECT * FROM channels WHERE id = ?', [course.channel_id]);
      if (!channel) return pauseWithError(courseId, 'Escolha o canal de destino do curso');
      const bot = await getBot();
      if (!bot) return pauseWithError(courseId, 'Bot não configurado');

      // Opening message, before anything else goes out
      if (course.description && !course.intro_msg_id) {
        const anySent = await db.getAsync("SELECT 1 FROM course_items WHERE course_id = ? AND status = 'sent' LIMIT 1", [courseId]);
        if (!anySent) {
          try {
            const msg = await sendHtml(bot, channel.chat_id, course, `📚 <b>${escapeHtml(course.name)}</b>\n\n${escapeHtml(course.description)}`);
            await db.runAsync('UPDATE courses SET intro_msg_id = ? WHERE id = ?', [String(msg.message_id), courseId]);
          } catch (err) {
            const info = telegramError(err);
            if (isFatal(info) || !info.status) return pauseWithError(courseId, info.message);
            // '0' = gave up on the opening message; the lessons still go out
            await db.runAsync("UPDATE courses SET intro_msg_id = '0' WHERE id = ?", [courseId]);
          }
          await sleep((course.delay_seconds || 3) * 1000);
          continue;
        }
      }

      const ctx = await loadContext(courseId);
      const item = ctx.items.find(i => i.status === 'pending');
      if (!item) return finishCourse(courseId);

      await db.runAsync("UPDATE course_items SET status = 'sending', error_msg = NULL WHERE id = ?", [item.id]);
      try {
        const messageId = await sendItem(bot, channel.chat_id, course, item, ctx, await getUploadLimit());
        await db.runAsync("UPDATE course_items SET status = 'sent', telegram_msg_id = ?, sent_at = datetime('now') WHERE id = ?", [messageId, item.id]);
        if (course.delete_after_upload && item.owned && item.file_path) fs.unlink(item.file_path, () => {});
      } catch (err) {
        const info = telegramError(err);
        if (isFatal(info)) {
          await db.runAsync("UPDATE course_items SET status = 'pending' WHERE id = ?", [item.id]);
          return pauseWithError(courseId, info.message);
        }
        await db.runAsync("UPDATE course_items SET status = 'failed', error_msg = ? WHERE id = ?", [info.message, item.id]);
      }
      await sleep((course.delay_seconds || 3) * 1000);
    }
  } catch (e) {
    console.error(`Course ${courseId} stopped:`, e);
    await pauseWithError(courseId, e.message).catch(() => {});
  } finally {
    running.delete(courseId);
  }
}

async function startCourse(courseId) {
  await db.runAsync("UPDATE courses SET status = 'running', last_error = NULL, updated_at = datetime('now') WHERE id = ?", [courseId]);
  runCourse(courseId).catch(console.error);
}

// The current file finishes uploading; the loop stops before the next one
async function pauseCourse(courseId) {
  await db.runAsync("UPDATE courses SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'running'", [courseId]);
}

function isRunning(courseId) {
  return running.has(courseId);
}

async function restoreCourses() {
  // A lesson caught mid-upload by a restart is sent again (it may appear twice on the channel)
  await db.runAsync("UPDATE course_items SET status = 'pending' WHERE status = 'sending'");
  const courses = await db.allAsync("SELECT id FROM courses WHERE status = 'running'");
  if (courses.length) console.log(`Resuming ${courses.length} course upload(s)...`);
  courses.forEach(c => runCourse(c.id).catch(console.error));
}

module.exports = {
  COURSES_DIR, IMPORT_DIR, DEFAULT_TEMPLATE, DEFAULT_SIGNATURE, MAX_FILE,
  courseFilesDir, safeRelPath, isIgnoredFile, addLessonFile, rebuildStructure, moveLesson, extractZip,
  scanFolder, listImportFolders, resolveImportFolder,
  lessonCaption, loadContext, tagsFor, messageLink, buildIndexMessages, hasFfmpeg,
  startCourse, pauseCourse, isRunning, postIndex, restoreCourses,
};
