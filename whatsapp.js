import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const logger = pino({ level: 'warn' });

let sock = null;
let connectionReady = false;
let latestQR = null;

/**
 * Membuat koneksi ke WhatsApp. Sesi disimpan di folder ./auth
 * sehingga QR hanya perlu di-scan sekali.
 */
export async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // kita render manual di bawah
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
      console.log('✅ WhatsApp terhubung & siap mengirim OTP.');
    }

    if (connection === 'close') {
      connectionReady = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `⚠️  Koneksi terputus (code ${statusCode}). ${
          shouldReconnect ? 'Menyambung ulang...' : 'Sesi logout, scan ulang QR.'
        }`,
      );
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  return sock;
}

export function isReady() {
  return connectionReady;
}

export function getLatestQR() {
  return latestQR;
}

/** Samarkan nomor: 628521234089 -> 62852****089 */
function maskNumber(n) {
  if (!n) return null;
  n = String(n);
  if (n.length <= 6) return n;
  return n.slice(0, 5) + '****' + n.slice(-3);
}

/**
 * Info akun WhatsApp yang sedang terhubung (nomor disamarkan & nama).
 * Nomor penuh sengaja TIDAK dikembalikan agar tidak bocor ke browser.
 */
export function getUser() {
  if (!connectionReady || !sock?.user) return null;
  const rawNumber = sock.user.id?.split(':')[0] || null;
  return {
    name: sock.user.name || sock.user.verifiedName || null,
    number: maskNumber(rawNumber),
  };
}

/** Logout / putus tautan perangkat. Hapus sesi & minta scan QR ulang. */
export async function logout() {
  if (!sock) throw new Error('Belum ada sesi aktif.');
  await sock.logout();
  connectionReady = false;
  latestQR = null;
}

/**
 * Normalisasi nomor menjadi JID WhatsApp.
 * Contoh: "08123456789" -> "628123456789@s.whatsapp.net"
 */
export function toJid(phone, defaultCountryCode = '62') {
  let n = String(phone).replace(/\D/g, '');
  if (n.startsWith('0')) n = defaultCountryCode + n.slice(1);
  if (!n.startsWith(defaultCountryCode) && n.length <= 12) {
    n = defaultCountryCode + n;
  }
  return `${n}@s.whatsapp.net`;
}

/**
 * Mengirim pesan teks ke sebuah nomor.
 * Memverifikasi dulu bahwa nomor terdaftar di WhatsApp.
 */
export async function sendMessage(phone, text) {
  if (!connectionReady || !sock) {
    throw new Error('WhatsApp belum terhubung. Coba lagi sebentar.');
  }

  const jid = toJid(phone);

  // 1) Cek nomor terdaftar di WhatsApp
  let result;
  try {
    [result] = await sock.onWhatsApp(jid);
  } catch (e) {
    throw new Error(`Gagal cek nomor (koneksi labil): ${describeError(e)}`);
  }
  if (!result?.exists) {
    throw new Error(`Nomor ${phone} tidak terdaftar di WhatsApp.`);
  }

  // 2) Kirim pesan
  try {
    await sock.sendMessage(result.jid, { text });
  } catch (e) {
    throw new Error(`Gagal mengirim pesan: ${describeError(e)}`);
  }
  return { jid: result.jid };
}

/** Ubah error apa pun (Error, Boom, string, objek) menjadi teks yang informatif. */
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
