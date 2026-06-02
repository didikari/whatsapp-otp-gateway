import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'whatsapp_api',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

/**
 * Pastikan tabel `messages` ada. Dipanggil sekali saat server start.
 */
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      target VARCHAR(32) NOT NULL,
      target_masked VARCHAR(32) NOT NULL,
      type ENUM('otp','message') NOT NULL DEFAULT 'message',
      status ENUM('success','failed') NOT NULL,
      error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Pengaturan admin (1 baris, id=1): password ter-hash & TOTP
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      id TINYINT PRIMARY KEY DEFAULT 1,
      password_hash VARCHAR(255) NOT NULL,
      totp_secret VARCHAR(64) NULL,
      totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  // Tes koneksi
  const [rows] = await pool.query('SELECT VERSION() AS v');
  console.log(`🗄️  MariaDB terhubung (${rows[0].v}).`);
}
