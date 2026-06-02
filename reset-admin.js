import 'dotenv/config';
import { pool } from './db.js';
import { ensureAdmin, setPassword, disableTotp } from './admin.js';

/**
 * Reset kredensial admin langsung di database.
 * Pemakaian:
 *   npm run reset-admin -- <password-baru>
 * Jika password tidak diberikan, dipakai "admin123".
 * Ini juga MENONAKTIFKAN 2FA (berguna kalau authenticator hilang).
 */
const newPassword = process.argv[2] || 'admin123';

try {
  await ensureAdmin(newPassword); // pastikan baris admin ada
  await setPassword(newPassword);
  await disableTotp();
  console.log('\n✅ Reset berhasil.');
  console.log('   Password admin   : ' + newPassword);
  console.log('   2FA (TOTP)       : DINONAKTIFKAN');
  console.log('\nLogin ke dashboard dengan password di atas, lalu aktifkan 2FA lagi bila perlu.\n');
} catch (err) {
  console.error('❌ Gagal reset:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
