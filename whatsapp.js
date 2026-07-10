import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';

const logger = pino({ level: 'warn' });

let sock = null;
let connectionReady = false;
let latestQR = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 3000;

export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log('\n📱 Scan QR berikut di WhatsApp > Perangkat Tertaut:\n');
      console.log('   (atau buka http://localhost:' + (process.env.PORT || 3000) + ' untuk scan dari browser)\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionReady = true;
      latestQR = null;
      reconnectAttempts = 0;
      console.log('✅ WhatsApp terhubung & siap mengirim OTP.');
      reportRestrictionStatus();
    }

    if (connection === 'close') {
      connectionReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (!shouldReconnect) {
        reconnectAttempts = 0;
        console.log('🔴 Sesi logout. Hapus folder ./auth lalu scan ulang QR.');
        return;
      }

      reconnectAttempts++;
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`🛑 Sudah ${reconnectAttempts - 1}x gagal reconnect (code ${statusCode}). Berhenti mencoba.`);
        reconnectAttempts = 0;
        return;
      }

      const delayMs = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1), 5 * 60 * 1000);
      console.log(`⚠️  Koneksi terputus (code ${statusCode}). Reconnect ke-${reconnectAttempts} dalam ${(delayMs / 1000).toFixed(0)}s...`);
      setTimeout(() => connectToWhatsApp(), delayMs);
    }
  });

  return sock;
}

export function isReady() {
  return connectionReady;
}

export async function reportRestrictionStatus() {
  if (!sock) return null;
  let lock = null;
  try {
    lock = await sock.fetchAccountReachoutTimelock();
    if (lock.isActive) {
      const ends = lock.timeEnforcementEnds
        ? lock.timeEnforcementEnds.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
        : 'tidak diketahui';
      console.warn(`🔒 Akun DIBATASI WhatsApp (reach-out time-lock, type: ${lock.enforcementType}). Berakhir: ${ends}`);
    } else {
      console.log('🔓 Tidak ada reach-out time-lock aktif.');
    }
  } catch (e) {
    console.warn(`⚠️  Gagal cek time-lock: ${describeError(e)}`);
  }
  try {
    const cap = await sock.fetchNewChatMessageCap();
    console.log('📊 Kuota chat baru:', JSON.stringify(cap));
  } catch (e) {
    console.warn(`⚠️  Gagal cek kuota chat baru: ${describeError(e)}`);
  }
  return lock;
}

export function getLatestQR() {
  return latestQR;
}

function maskNumber(n) {
  if (!n) return null;
  n = String(n);
  if (n.length <= 6) return n;
  return n.slice(0, 5) + '****' + n.slice(-3);
}

export function getUser() {
  if (!connectionReady || !sock?.user) return null;
  const rawNumber = sock.user.id?.split(':')[0] || null;
  return {
    name: sock.user.name || sock.user.verifiedName || null,
    number: maskNumber(rawNumber),
  };
}

export async function logout() {
  if (!sock) throw new Error('Belum ada sesi aktif.');
  await sock.logout();
  connectionReady = false;
  latestQR = null;
}

export async function resetSession() {
  if (sock) {
    try { sock.end(new Error('Manual reset')); } catch {}
    sock = null;
  }
  connectionReady = false;
  latestQR = null;
  reconnectAttempts = 0;

  try {
    fs.rmSync('auth', { recursive: true, force: true });
    console.log('🗑️  Folder ./auth dihapus.');
  } catch (e) {
    console.warn('⚠️  Gagal hapus ./auth:', e.message);
  }

  await connectToWhatsApp();
}

export function toJid(phone, defaultCountryCode = '62') {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('0')) n = defaultCountryCode + n.slice(1);
  if (!n.startsWith(defaultCountryCode) && n.length <= 12) {
    n = defaultCountryCode + n;
  }
  return `${n}@s.whatsapp.net`;
}

export async function sendMessage(phone, text) {
  if (!connectionReady || !sock) {
    throw new Error('WhatsApp belum terhubung. Coba lagi sebentar.');
  }

  const jid = toJid(phone);
  let targetJid = jid;
  try {
    const results = await sock.onWhatsApp(jid);
    console.log(`🔎 onWhatsApp ${phone} ->`, JSON.stringify(results));
    const result = results?.[0];
    if (result?.exists && result.jid) {
      targetJid = result.jid;
    } else {
      console.warn(`⚠️  onWhatsApp tidak menemukan ${phone}; tetap mencoba kirim langsung ke ${jid}.`);
    }
  } catch (e) {
    console.warn(`⚠️  Gagal cek nomor ${phone} (${describeError(e)}); tetap mencoba kirim langsung.`);
  }

  try {
    await sock.sendMessage(targetJid, { text });
  } catch (e) {
    throw new Error(`Gagal mengirim pesan: ${describeError(e)}`);
  }
  return { jid: targetJid };
}

function describeError(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return (
    e.message ||
    e.output?.payload?.message ||
    e.reason ||
    (e.output?.statusCode ? `status ${e.output.statusCode}` : '') ||
    JSON.stringify(e)
  );
}
