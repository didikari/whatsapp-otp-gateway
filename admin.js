import crypto from 'crypto';
import { pool } from './db.js';

/* ===== Hashing password (scrypt, tanpa dependency tambahan) ===== */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyHash(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const h = crypto.scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ===== Akses baris admin (selalu id = 1) ===== */
export async function getAdmin() {
  const [rows] = await pool.query('SELECT * FROM admin_settings WHERE id = 1');
  return rows[0] || null;
}

/**
 * Seed admin pertama kali dari ADMIN_PASSWORD (.env) jika belum ada.
 * Setelah ini, .env tidak lagi dipakai untuk autentikasi.
 */
export async function ensureAdmin(defaultPassword) {
  const admin = await getAdmin();
  if (admin) return admin;
  const hash = hashPassword(defaultPassword || 'admin123');
  await pool.query(
    'INSERT INTO admin_settings (id, password_hash, totp_secret, totp_enabled) VALUES (1, ?, NULL, 0)',
    [hash],
  );
  console.log('👤 Admin awal dibuat dari ADMIN_PASSWORD (.env). Ganti password lewat dashboard.');
  return getAdmin();
}

export async function verifyPassword(plain) {
  const admin = await getAdmin();
  return admin ? verifyHash(plain, admin.password_hash) : false;
}

export async function setPassword(plain) {
  await pool.query('UPDATE admin_settings SET password_hash = ? WHERE id = 1', [hashPassword(plain)]);
}

/* ===== TOTP ===== */
export async function isTotpEnabled() {
  const admin = await getAdmin();
  return !!(admin && admin.totp_enabled);
}

export async function getTotpSecret() {
  const admin = await getAdmin();
  return admin?.totp_secret || null;
}

/** Simpan secret baru sebagai "pending" (belum aktif sampai dikonfirmasi kode). */
export async function setPendingTotp(secret) {
  await pool.query('UPDATE admin_settings SET totp_secret = ?, totp_enabled = 0 WHERE id = 1', [secret]);
}

export async function enableTotp() {
  await pool.query('UPDATE admin_settings SET totp_enabled = 1 WHERE id = 1');
}

export async function disableTotp() {
  await pool.query('UPDATE admin_settings SET totp_secret = NULL, totp_enabled = 0 WHERE id = 1');
}
