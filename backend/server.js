const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const path = require('path');
const { initSchema } = require('./db');
const { restorePendingJobs } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3131;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ createParentPath: true, limits: { fileSize: 50 * 1024 * 1024 } }));

// Basic Authentication
const authUser = process.env.AUTH_USER || 'admin';
const authPass = process.env.AUTH_PASS || 'admin';
const basicAuth = (req, res, next) => {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login && password && login === authUser && password === authPass) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Disparos Mestre"');
  res.status(401).send('Authentication required.');
};
app.use(basicAuth);

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// API Routes
app.use('/api/channels', require('./routes/channels'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/stats', require('./routes/stats'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Bootstrap
async function main() {
  await initSchema();
  console.log('✅ Database initialized');

  await restorePendingJobs();
  console.log('✅ Pending jobs restored');

  app.listen(PORT, () => {
    console.log(`🚀 Telegram Blast running at http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
