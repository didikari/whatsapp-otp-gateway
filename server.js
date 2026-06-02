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
// Token utama (Fonnte-style). Mendukung nama lama API_KEY agar tetap kompatibel.
const SECRET_KEY = process.env.SECRET_KEY || process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || '';
const APP_NAME = process.env.APP_NAME || 'OTP';
const RATE_LIMIT = Number(process.env.OTP_RATE_LIMIT_PER_MINUTE || 3);
// ADMIN_PASSWORD di .env hanya dipakai untuk seed admin pertama kali.
const ADMIN_SEED_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0);
const APP_LABEL = APP_NAME || 'WhatsApp API';

const app = express();
app.set('trust proxy', TRUST_PROXY); // baca IP asli di belakang reverse proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // dukung body form (seperti Fonnte)
app.use(express.static('public'));

// Middleware whitelist IP untuk endpoint API
const ipWhitelist = createIpWhitelist(process.env.ALLOWED_IPS);

// Ambil token dari header Authorization (Fonnte) / x-api-key / Bearer.
function extractToken(req) {
  let h = req.headers['authorization'] || req.headers['x-api-key'] || '';
  if (h.toLowerCase().startsWith('bearer ')) h = h.slice(7);
  return h.trim();
}

// --- Middleware: cek secret key (integrasi) ATAU session admin (dashboard) ---
function auth(req, res, next) {
  const token = extractToken(req);
  const validToken = SECRET_KEY && token === SECRET_KEY;
  const validSession = validateSession(req.headers['x-admin-token']);
  if (!validToken && !validSession) {
    return res.status(401).json({ status: false, message: 'Secret key / sesi admin tidak valid.' });
  }
  next();
}

// --- Middleware: butuh sesi admin aktif (token dari login) ---
function adminAuth(req, res, next) {
  if (!validateSession(req.headers['x-admin-token'])) {
    return res.status(401).json({ success: false, message: 'Sesi tidak valid / kedaluwarsa. Login ulang.' });
  }
  next();
}

// --- Rate limit khusus login (anti brute-force) ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi nanti.' },
});

// --- Rate limit per nomor tujuan ---
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT,
  keyGenerator: (req) => req.body?.target || req.body?.phone || ipKeyGenerator(req.ip),
  message: { success: false, message: 'Terlalu banyak permintaan OTP. Coba lagi nanti.' },
});

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ success: true, whatsappReady: isReady() });
});

// --- Status koneksi + QR + info user (untuk dashboard) ---
app.get('/status', async (req, res) => {
  const qr = getLatestQR();
  let qrImage = null;
  if (qr && !isReady()) {
    qrImage = await QRCode.toDataURL(qr);
  }
  res.json({ ready: isReady(), qr: qrImage, user: getUser() });
});

// --- Konfigurasi publik untuk halaman login (apakah TOTP wajib) ---
app.get('/admin/config', async (req, res) => {
  res.json({ totpEnabled: await isTotpEnabled() });
});

// --- Admin: login (password + TOTP) -> terbitkan session token ---
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

// --- Admin: logout sesi dashboard ---
app.post('/admin/signout', adminAuth, (req, res) => {
  destroySession(req.headers['x-admin-token']);
  res.json({ success: true });
});

// --- Admin: status keamanan (untuk panel Pengaturan) ---
app.get('/admin/security', adminAuth, async (req, res) => {
  res.json({ success: true, totpEnabled: await isTotpEnabled() });
});

// --- Admin: ganti password ---
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

// --- Admin: mulai setup 2FA -> buat secret pending + QR ---
app.post('/admin/2fa/setup', adminAuth, async (req, res) => {
  try {
    const secret = generateSecret();
    await setPendingTotp(secret); // disimpan tapi belum aktif
    const uri = generateURI({ issuer: APP_LABEL, label: 'admin', secret });
    const qr = await QRCode.toDataURL(uri);
    res.json({ success: true, secret, qr });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Admin: konfirmasi & aktifkan 2FA ---
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

// --- Admin: nonaktifkan 2FA (butuh password) ---
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

// --- Admin: kredensial API (URL + secret key) untuk panel integrasi ---
app.get('/admin/credentials', adminAuth, (req, res) => {
  const baseUrl = BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    baseUrl,
    secretKey: SECRET_KEY || '',
    whitelist: { enabled: ipWhitelist.enabled, ips: ipWhitelist.list },
  });
});

// --- Admin: statistik ringkas ---
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    res.json({ success: true, stats: await getStats() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Admin: riwayat pengiriman ---
app.get('/admin/history', adminAuth, async (req, res) => {
  try {
    res.json({ success: true, history: await getHistory(50) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- Admin: logout / unlink perangkat ---
app.post('/admin/logout', adminAuth, async (req, res) => {
  try {
    await logout();
    res.json({ success: true, message: 'Perangkat di-unlink. Scan QR ulang untuk konek lagi.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /send  — Pola seperti Fonnte (pesan bebas)
 * Header: Authorization: <SECRET_KEY>
 * Body (JSON / form): { "target": "08123456789", "message": "Halo" }
 * Response: { status, detail, id, target }
 */
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

    return res.json({
      status: true,
      detail: 'success! message sent',
      id: [jid],
      target,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (target) await record({ phone: target, status: 'failed', type: 'message', error: msg });
    return res.status(500).json({ status: false, detail: msg });
  }
});

/**
 * POST /send-otp  — endpoint khusus OTP (template otomatis)
 * Header: Authorization: <SECRET_KEY>
 * Body: { "target": "08123456789", "otp": "123456" }  (otp opsional)
 */
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

    const text =
      message ||
      `*${APP_NAME}*\n\nKode OTP Anda adalah: *${code}*\n\nJangan bagikan kode ini kepada siapa pun. Berlaku 5 menit.`;

    const { jid } = await sendMessage(target, text);
    await record({ phone: target, status: 'success', type: 'otp' });

    return res.json({
      status: true,
      detail: 'success! OTP sent',
      id: [jid],
      target,
      // OTP dikembalikan agar aplikasi Anda bisa menyimpan/memverifikasinya.
      otp: code,
    });
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
    await ensureAdmin(ADMIN_SEED_PASSWORD); // seed admin pertama kali dari .env
  } catch (err) {
    console.error('❌ Gagal konek MariaDB:', err.message);
    console.error('   Periksa konfigurasi DB_* di .env dan pastikan MariaDB jalan.');
  }
  console.log('⏳ Menghubungkan ke WhatsApp...');
  await connectToWhatsApp();
});
