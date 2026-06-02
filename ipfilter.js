/**
 * IP whitelist sederhana: mendukung IP tunggal (IPv4/IPv6) & CIDR IPv4.
 * Dipakai sebagai middleware Express.
 */

// Normalisasi IPv4-mapped IPv6 (mis. "::ffff:127.0.0.1" -> "127.0.0.1")
function normalize(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Ubah IPv4 jadi integer 32-bit; null kalau bukan IPv4 valid
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

// Cek apakah `ip` cocok dengan satu entry whitelist (IP tunggal / CIDR)
function matchEntry(ip, entry) {
  entry = entry.trim();
  if (!entry) return false;

  if (entry.includes('/')) {
    // CIDR IPv4
    const [base, bitsStr] = entry.split('/');
    const bits = Number(bitsStr);
    const ipInt = ipv4ToInt(ip);
    const baseInt = ipv4ToInt(base);
    if (ipInt === null || baseInt === null || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  // IP tunggal (cocokkan persis, IPv4 maupun IPv6)
  return normalize(entry) === ip;
}

/**
 * Buat middleware whitelist dari string env (dipisah koma).
 * Jika daftar kosong → izinkan semua (whitelist nonaktif).
 */
export function createIpWhitelist(allowedRaw) {
  const list = (allowedRaw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const enabled = list.length > 0;
  if (enabled) {
    console.log(`🛡️  IP whitelist aktif: ${list.join(', ')}`);
  }

  function ipWhitelist(req, res, next) {
    if (!enabled) return next();
    const ip = normalize(req.ip);
    const allowed = list.some((entry) => matchEntry(ip, entry));
    if (!allowed) {
      console.warn(`⛔ Akses ditolak dari IP: ${ip}`);
      return res.status(403).json({ status: false, message: `IP ${ip} tidak diizinkan.` });
    }
    next();
  }

  // Metadata untuk ditampilkan di dashboard
  ipWhitelist.enabled = enabled;
  ipWhitelist.list = list;
  return ipWhitelist;
}
