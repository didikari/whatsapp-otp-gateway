# WhatsApp API (Baileys) — Pola Fonnte

WhatsApp gateway sederhana untuk kirim pesan & OTP menggunakan
[Baileys](https://github.com/WhiskeySockets/Baileys), dengan pola integrasi
**seperti Fonnte**: ada **URL endpoint** + **Secret Key** yang dikirim lewat
header `Authorization`. Dilengkapi **admin dashboard**.

## Setup

1. Edit `.env`:
   - `SECRET_KEY` → token rahasia untuk akses API (ganti dengan string acak kuat).
   - `ADMIN_PASSWORD` → password login dashboard.
   - `BASE_URL` → (opsional) URL publik server untuk contoh di dashboard.
   - `DB_*` → koneksi MariaDB (host, port, user, password, nama database).
2. Pastikan **MariaDB** berjalan & database ada. Tabel `messages` dibuat
   otomatis saat server start. Buat database (sekali):

   ```sql
   CREATE DATABASE whatsapp_api CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. Jalankan:

   ```bash
   npm start
   ```

4. Buka **http://localhost:3000** → login → **scan QR** dari dashboard
   (atau dari terminal). Sesi tersimpan di `auth/`, scan cukup sekali.

## Pola Penggunaan (seperti Fonnte)

- **URL**   : `http://<host>:3000/send`
- **Auth**  : header `Authorization: <SECRET_KEY>`
- **Body**  : `target`, `message` (form-data atau JSON)

### Kirim pesan — `POST /send`

```bash
curl -X POST http://localhost:3000/send \
  -H "Authorization: SECRET_KEY_ANDA" \
  -d "target=08123456789" \
  -d "message=Halo dari WhatsApp API"
```

Response:

```json
{ "status": true, "detail": "success! message sent", "id": ["628...@s.whatsapp.net"], "target": "08123456789" }
```

### Kirim OTP — `POST /send-otp`

Template OTP otomatis. `otp` opsional (kosong = generate 6 digit acak).

```bash
curl -X POST http://localhost:3000/send-otp \
  -H "Authorization: SECRET_KEY_ANDA" \
  -d "target=08123456789"
```

```json
{ "status": true, "detail": "success! OTP sent", "id": ["..."], "target": "08123456789", "otp": "123456" }
```

### Parameter

| Field     | Endpoint        | Wajib | Keterangan                                          |
|-----------|-----------------|-------|-----------------------------------------------------|
| `target`  | /send, /send-otp| ✅    | Nomor tujuan (`08...`/`628...` otomatis dinormalisasi)|
| `message` | /send           | ✅    | Isi pesan                                            |
| `message` | /send-otp       | ❌    | Override template OTP                                |
| `otp`     | /send-otp       | ❌    | Kode OTP; kosong = generate otomatis                 |

> Header `Authorization` menerima nilai langsung (`SECRET_KEY`) maupun
> format `Bearer SECRET_KEY`. Header lama `x-api-key` juga masih didukung.

## Admin Dashboard

`http://localhost:3000` → login pakai `ADMIN_PASSWORD`. Berisi:
status koneksi & info nomor, statistik (total/hari ini/sukses/gagal),
QR login, form kirim, riwayat pengiriman, tombol unlink, dan
**panel Integrasi API** (URL + Secret Key + contoh cURL/PHP/Node.js).

## Keamanan: IP Whitelist

Endpoint `/send` & `/send-otp` bisa dibatasi hanya untuk IP tertentu via `.env`:

```env
# Kosong = izinkan semua (whitelist nonaktif)
ALLOWED_IPS=127.0.0.1,::1,103.20.0.0/16
TRUST_PROXY=0   # set 1 jika di belakang Nginx/Cloudflare
```

- Mendukung **IP tunggal** (IPv4/IPv6) dan **CIDR IPv4** (mis. `192.168.1.0/24`).
- IP di luar daftar mendapat `403 { "status": false, "message": "IP ... tidak diizinkan." }`.
- Jika server di belakang **reverse proxy**, set `TRUST_PROXY=1` agar IP asli
  (dari header `X-Forwarded-For`) terbaca benar — kalau tidak, semua request
  terlihat berasal dari IP proxy.
- ⚠️ Perubahan `.env` baru aktif setelah **restart** server (dotenv dibaca saat start).

> Whitelist berlaku juga untuk pengiriman dari dashboard (yang memakai endpoint
> yang sama). Login admin tetap di-proteksi password terpisah.

## Keamanan: Akun Admin (password di DB + 2FA)

Kredensial admin **tidak** lagi disimpan di `.env`. `ADMIN_PASSWORD` di `.env`
hanya dipakai untuk **membuat akun admin pertama kali** (seed) di database
(tabel `admin_settings`, password disimpan **ter-hash** dengan scrypt).
Semua pengelolaan dilakukan dari dashboard.

**Dari panel "🔒 Keamanan Akun" di dashboard:**
- **Ganti password** (butuh password saat ini).
- **Aktifkan 2FA**: klik "Aktifkan 2FA" → scan QR yang muncul dengan
  Google Authenticator / Authy → masukkan 6 digit untuk konfirmasi.
- **Nonaktifkan 2FA**: butuh password.

**Login** (`POST /admin/login`) memvalidasi password (+ TOTP bila aktif) lalu
menerbitkan **session token** acak (berlaku `SESSION_TTL_HOURS` jam, default 8).
Semua aksi admin memakai token ini (header `x-admin-token`), bukan password
mentah. Login dibatasi **10 percobaan / 15 menit per IP**.

### Lupa password / hilang authenticator → Reset

Akses ke server = tepercaya. Reset langsung dari terminal:

```bash
npm run reset-admin -- passwordBaruAnda
```

Perintah ini mengganti password admin **dan menonaktifkan 2FA**. Setelah itu
login dengan password baru, lalu aktifkan 2FA lagi bila perlu.

> Integrasi API (`/send`, `/send-otp`) tetap memakai **Secret Key** via header
> `Authorization` dan **tidak** terpengaruh login/2FA admin.

## Endpoint lain

- `GET /health`   → cek status koneksi.
- `GET /status`   → status + QR + info user (dipakai dashboard).
- `GET /admin/config` → apakah 2FA wajib (publik, untuk halaman login).
- `POST /admin/login` → password (+ TOTP) → session token.
- Butuh header `x-admin-token` (session token):
  - `GET /admin/{stats,history,credentials,security}`
  - `POST /admin/{signout,logout,change-password}`
  - `POST /admin/2fa/{setup,enable,disable}`

## Menjalankan di Produksi (PM2)

Project ini Node.js murni — **tidak ada langkah build/compile**. Untuk produksi,
pakai **PM2** agar proses auto-restart, terkelola, dan jalan saat server boot.

```bash
npm install -g pm2          # sekali saja
npm install --omit=dev      # dependency produksi
pm2 start ecosystem.config.cjs   # atau: npm run prod
pm2 save                    # simpan agar dipulihkan saat reboot
pm2 startup                 # ikuti perintah sudo yang ditampilkan (jalan saat boot)
```

Perintah harian:

| Perintah | Fungsi |
|----------|--------|
| `npm run prod` / `pm2 start ecosystem.config.cjs` | Jalankan |
| `pm2 status` | Lihat status |
| `npm run logs` / `pm2 logs whatsapp-api` | Lihat log (juga di `./logs/`) |
| `pm2 restart whatsapp-api` | Restart |
| `npm run stop` / `pm2 stop whatsapp-api` | Hentikan |
| `pm2 monit` | Monitor CPU/memori realtime |

> ⚠️ **Selalu 1 instance** (sudah diatur di `ecosystem.config.cjs`:
> `instances: 1`, `exec_mode: 'fork'`). Baileys hanya mengizinkan satu koneksi
> per sesi WhatsApp — mode cluster / proses ganda memicu `code 428` (saling
> tendang) dan pengiriman gagal.

Saat scan QR pertama kali di server tanpa layar, lihat QR via `pm2 logs whatsapp-api`
atau buka dashboard `http://<server>:3000`.

## Catatan penting

- Baileys memakai WhatsApp Web (tidak resmi). Untuk produksi volume besar /
  kritis, pertimbangkan WhatsApp Business API resmi agar nomor tidak diblokir.
- Ganti `SECRET_KEY` & `ADMIN_PASSWORD` sebelum dipakai. Jangan kirim pesan massal.
