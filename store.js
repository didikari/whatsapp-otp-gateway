import { pool } from './db.js';

/** Samarkan nomor: 628123****789 */
function maskPhone(phone) {
  const n = String(phone);
  if (n.length <= 6) return n;
  return n.slice(0, 5) + '****' + n.slice(-3);
}

/** Catat satu pengiriman ke DB. */
export async function record({ phone, status, type = 'message', error = null }) {
  await pool.query(
    'INSERT INTO messages (target, target_masked, type, status, error) VALUES (?, ?, ?, ?, ?)',
    [String(phone), maskPhone(phone), type, status, error],
  );
}

/** Ambil riwayat terbaru (nomor sudah disamarkan). */
export async function getHistory(limit = 50) {
  const [rows] = await pool.query(
    'SELECT id, target_masked AS phone, type, status, created_at AS at FROM messages ORDER BY id DESC LIMIT ?',
    [Number(limit)],
  );
  return rows;
}

/** Statistik ringkas. */
export async function getStats() {
  const [[totals]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'success') AS success,
       SUM(status = 'failed')  AS failed,
       SUM(DATE(created_at) = CURDATE()) AS today
     FROM messages`,
  );
  return {
    total: Number(totals.total || 0),
    success: Number(totals.success || 0),
    failed: Number(totals.failed || 0),
    today: Number(totals.today || 0),
  };
}
