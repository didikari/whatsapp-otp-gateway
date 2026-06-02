/**
 * Konfigurasi PM2 untuk WhatsApp API.
 * Jalankan: pm2 start ecosystem.config.cjs
 *
 * PENTING: instances HARUS 1. Baileys hanya mengizinkan satu koneksi per
 * sesi WhatsApp — menjalankan lebih dari satu proses akan memicu code 428
 * (saling tendang) dan pengiriman gagal. Jangan pakai mode cluster / --watch.
 */
module.exports = {
  apps: [
    {
      name: 'whatsapp-api',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork', // BUKAN cluster
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      // Beri jeda saat restart agar koneksi lama benar-benar tertutup
      restart_delay: 3000,
      min_uptime: '10s',
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      // Log
      time: true, // timestamp pada setiap baris log
      output: './logs/out.log',
      error: './logs/error.log',
      merge_logs: true,
    },
  ],
};
