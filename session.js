import crypto from 'crypto';

/**
 * Penyimpanan sesi admin sederhana (in-memory).
 * Token diterbitkan setelah login (password + TOTP) berhasil.
 */
const sessions = new Map(); // token -> expiresAt (ms epoch)
const TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;

/** Buat sesi baru, kembalikan token acak. */
export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + TTL_MS);
  return token;
}

/** Validasi token; hapus jika kedaluwarsa. */
export function validateSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Hapus sesi (logout). */
export function destroySession(token) {
  sessions.delete(token);
}

// Bersihkan sesi kedaluwarsa berkala
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
}, 10 * 60 * 1000).unref();
