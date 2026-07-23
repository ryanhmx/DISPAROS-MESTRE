const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { verifyChannel } = require('../bot');

// GET /api/channels
router.get('/', async (req, res) => {
  try {
    const channels = await db.allAsync(`
      SELECT c.*, g.name as group_name, g.color as group_color
      FROM channels c
      LEFT JOIN channel_groups g ON g.id = c.group_id
      ORDER BY c.created_at DESC
    `);
    res.json(channels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/channels
router.post('/', async (req, res) => {
  try {
    const { name, chat_id, username, group_id } = req.body;
    if (!name || !chat_id) return res.status(400).json({ error: 'name e chat_id são obrigatórios' });
    const id = uuidv4();
    await db.runAsync(
      'INSERT INTO channels (id, name, chat_id, username, group_id) VALUES (?, ?, ?, ?, ?)',
      [id, name, chat_id, username || null, group_id || null]
    );
    const ch = await db.getAsync('SELECT * FROM channels WHERE id = ?', [id]);
    res.json(ch);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Chat ID já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/channels/bulk
router.post('/bulk', async (req, res) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) return res.status(400).json({ error: 'Nenhum canal fornecido' });
    
    let added = 0;
    for (const c of channels) {
      if (!c.name || !c.chat_id) continue;
      const id = uuidv4();
      try {
        await db.runAsync(
          'INSERT INTO channels (id, name, chat_id) VALUES (?, ?, ?)',
          [id, c.name, c.chat_id]
        );
        added++;
      } catch (err) {
        // Ignore UNIQUE constraint errors to skip duplicates
      }
    }
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/channels/:id
router.put('/:id', async (req, res) => {
  try {
    const existing = await db.getAsync('SELECT * FROM channels WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Canal não encontrado' });

    const name = req.body.name !== undefined ? req.body.name : existing.name;
    const chat_id = req.body.chat_id !== undefined ? req.body.chat_id : existing.chat_id;
    const username = req.body.username !== undefined ? (req.body.username || null) : existing.username;
    const group_id = req.body.group_id !== undefined ? (req.body.group_id || null) : existing.group_id;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

    await db.runAsync(
      'UPDATE channels SET name=?, chat_id=?, username=?, group_id=?, active=? WHERE id=?',
      [name, chat_id, username, group_id, active, req.params.id]
    );
    const ch = await db.getAsync('SELECT * FROM channels WHERE id = ?', [req.params.id]);
    res.json(ch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/channels/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM channels WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/channels/:id/verify
router.post('/:id/verify', async (req, res) => {
  try {
    const ch = await db.getAsync('SELECT * FROM channels WHERE id = ?', [req.params.id]);
    if (!ch) return res.status(404).json({ error: 'Canal não encontrado' });
    const result = await verifyChannel(ch.chat_id);
    if (result.ok) {
      await db.runAsync('UPDATE channels SET verified = 1, name = ? WHERE id = ?', [result.title || ch.name, ch.id]);
    } else {
      await db.runAsync('UPDATE channels SET verified = 0 WHERE id = ?', [ch.id]);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Groups ---
// GET /api/channels/groups
router.get('/groups/all', async (req, res) => {
  try {
    const groups = await db.allAsync('SELECT * FROM channel_groups ORDER BY name');
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/channels/groups
router.post('/groups', async (req, res) => {
  try {
    const { name, color } = req.body;
    const id = uuidv4();
    await db.runAsync('INSERT INTO channel_groups (id, name, color) VALUES (?, ?, ?)',
      [id, name, color || '#6c63ff']);
    const g = await db.getAsync('SELECT * FROM channel_groups WHERE id = ?', [id]);
    res.json(g);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/channels/groups/:id
router.delete('/groups/:id', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM channel_groups WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
