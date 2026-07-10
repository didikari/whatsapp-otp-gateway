import 'dotenv/config';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import QRCode from 'qrcode';
import {
  connectToWhatsApp,
  sendMessage,
  isReady,
  getLatestQR,
  getUser,
  logout,
  resetSession,
} from './whatsapp.js';
import { verifySync, generateSecret, generateURI } from 'otplib';
import { record, getHistory, getStats } from './store.js';
import { initDb } from './db.js';
import { createIpWhitelist } from './ipfilter.js';
import { createSession, validateSession, destroySession } from './session.js';
import {
  ensureAdmin,
  verifyPassword,
  setPassword,
  isTotpEnabled,
  getTotpSecret,
  setPendingTotp,
  enableTotp,
  disableTotp,
} from './admin.js';

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || '';
const APP_NAME = process.env.APP_NAME || 'OTP';
const RATE_LIMIT = Number(process.env.OTP_RATE_LIMIT_PER_MINUTE || 3);
const ADMIN_SEED_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);
const APP_LABEL = APP_NAME || 'WhatsApp API';

const app = express();
app.set('trust proxy', TRUST_PROXY);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const ipWhitelist = createIpWhitelist(process.env.ALLOWED_IPS);

function extractToken(req) {
  let h = req.headers['authorization'] || req.headers['x-api-key'] || '';
  if (h.toLowerCase().startsWith('bearer ')) h = h.slice(7);
  return h.trim();
}

function auth(req, res, next) {
  const token = extractToken(req);
  const validToken = SECRET_KEY && token === SECRET_KEY;
  const validSession = validateSession(req.headers['x-admin-token']);
  if (!validToken && !validSession) {
    return res.status(401).json({ status: false, message: 'Secret key / sesi admin tidak valid.' });
  }
  next();
}

function adminAuth(req, res, next) {
  if (!validateSession(req.headers['x-admin-token'])) {
    return res.status(401).json({ success: false, message: 'Sesi tidak valid / kedaluwarsa. Login ulang.' });
  }
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi nanti.' },
});

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT,
  keyGenerator: (req) => req.body?.target || req.body?.phone || ipKeyGenerator(req.ip),
  message: { success: false, message: 'Terlalu banyak permintaan OTP. Coba lagi nanti.' },
});

app.get('/health', (req, res) => {
  res.json({ success: true, whatsappReady: isReady() });
});

app.get('/status', async (req, res) => {
  const qr = getLatestQR();
  let qrImage = null;
  if (qr && !isReady()) qrImage = await QRCode.toDataURL(qr);
  res.json({ ready: isReady(), qr: qrImage, user: getUser() });
});

app.get('/admin/config', async (req, res) => {
  res.json({ totpEnabled: await isTotpEnabled() });
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  try {
    const password = req.body?.password ?? req.headers['x-admin-password'] ?? '';
    const totp = String(req.body?.totp || '').trim();

    if (!(await verifyPassword(password))) {
      return res.status(401).json({ success: false, message: 'Password salah.' });
    }
    if (await isTotpEnabled()) {
      if (!totp) {
        return res.status(401).json({ success: false, message: 'Kode authenticator wajib diisi.' });
      }
      const secret = await getTotpSecret();
      const result = verifySync({ token: totp, secret, strategy: 'totp', counterTolerance: 1 });
      if (!result.valid) {
        return res.status(401).json({ success: false, message: 'Kode authenticator salah / kedaluwarsa.' });
      }
    }

    const token = createSession();
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/signout', adminAuth, (req, res) => {
  destroySession(req.headers['x-admin-token']);
  res.json({ success: true });
});

app.get('/admin/security', adminAuth, async (req, res) => {
  res.json({ success: true, totpEnabled: await isTotpEnabled() });
});

app.post('/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
    }
    if (!(await verifyPassword(currentPassword || ''))) {
      return res.status(401).json({ success: false, message: 'Password saat ini salah.' });
    }
    await setPassword(String(newPassword));
    res.json({ success: true, message: 'Password berhasil diubah.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/2fa/setup', adminAuth, async (req, res) => {
  try {
    const secret = generateSecret();
    await setPendingTotp(secret);
    const uri = generateURI({ issuer: APP_LABEL, label: 'admin', secret });
    const qr = await QRCode.toDataURL(uri);
    res.json({ success: true, secret, qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/2fa/enable', adminAuth, async (req, res) => {
  try {
    const totp = String(req.body?.totp || '').trim();
    const secret = await getTotpSecret();
    if (!secret) {
      return res.status(400).json({ success: false, message: 'Belum ada setup 2FA. Mulai setup dulu.' });
    }
    const result = verifySync({ token: totp, secret, strategy: 'totp', counterTolerance: 1 });
    if (!result.valid) {
      return res.status(401).json({ success: false, message: 'Kode salah. Pastikan jam perangkat sinkron.' });
    }
    await enableTotp();
    res.json({ success: true, message: '2FA aktif.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/2fa/disable', adminAuth, async (req, res) => {
  try {
    if (!(await verifyPassword(req.body?.password || ''))) {
      return res.status(401).json({ success: false, message: 'Password salah.' });
    }
    await disableTotp();
    res.json({ success: true, message: '2FA dinonaktifkan.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/admin/credentials', adminAuth, (req, res) => {
  const baseUrl = BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    baseUrl,
    secretKey: SECRET_KEY || '',
    whitelist: { enabled: ipWhitelist.enabled, ips: ipWhitelist.list },
  });
});

app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    res.json({ success: true, stats: await getStats() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/admin/history', adminAuth, async (req, res) => {
  try {
    res.json({ success: true, history: await getHistory(50) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/logout', adminAuth, async (req, res) => {
  try {
    await logout();
    res.json({ success: true, message: 'Perangkat di-unlink. Scan QR ulang untuk konek lagi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/admin/reset-session', adminAuth, async (req, res) => {
  res.json({ success: true, message: 'Sesi di-reset. QR akan muncul sebentar lagi.' });
  setImmediate(() => resetSession().catch(console.error));
});

app.post('/send', ipWhitelist, auth, otpLimiter, async (req, res) => {
  const target = req.body?.target;
  const message = req.body?.message;
  try {
    if (!target || !message) {
      return res.status(400).json({ status: false, detail: 'Field "target" dan "message" wajib diisi.' });
    }
    if (!isReady()) {
      return res.status(503).json({ status: false, detail: 'WhatsApp belum siap. Scan QR dulu.' });
    }
    const { jid } = await sendMessage(target, message);
    await record({ phone: target, status: 'success', type: 'message' });
    return res.json({ status: true, detail: 'success! message sent', id: [jid], target });
  } catch (err) {
    const msg = err?.message || String(err);
    if (target) await record({ phone: target, status: 'failed', type: 'message', error: msg });
    return res.status(500).json({ status: false, detail: msg });
  }
});

app.post('/send-otp', ipWhitelist, auth, otpLimiter, async (req, res) => {
  const target = req.body?.target || req.body?.phone;
  try {
    const { otp, message } = req.body || {};
    if (!target) {
      return res.status(400).json({ status: false, message: 'Field "target" wajib diisi.' });
    }
    if (!isReady()) {
      return res.status(503).json({ status: false, message: 'WhatsApp belum siap. Scan QR dulu.' });
    }
    const code = otp || String(Math.floor(100000 + Math.random() * 900000));
    const text = message || `*${APP_NAME}*\n\nKode OTP Anda adalah: *${code}*\n\nJangan bagikan kode ini kepada siapa pun. Berlaku 5 menit.`;
    const { jid } = await sendMessage(target, text);
    await record({ phone: target, status: 'success', type: 'otp' });
    return res.json({ status: true, detail: 'success! OTP sent', id: [jid], target, otp: code });
  } catch (err) {
    const msg = err?.message || String(err);
    if (target) await record({ phone: target, status: 'failed', type: 'otp', error: msg });
    return res.status(500).json({ status: false, detail: msg });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  try {
    await initDb();
    await ensureAdmin(ADMIN_SEED_PASSWORD);
  } catch (err) {
    console.error('❌ Gagal konek MariaDB:', err.message);
  }
  console.log('⏳ Menghubungkan ke WhatsApp...');
  await connectToWhatsApp();
});
