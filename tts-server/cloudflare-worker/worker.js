/**
 * 页灯听书 · 免费 Cloudflare Worker Edge-TTS 代理（支持 2026 Sec-MS-GEC v2 协议）。
 *
 * 部署后在 Cloudflare Worker -> Settings -> Triggers -> Custom Domains
 * 绑定你自己的子域名（如 tts.yourdomain.com），即可在中国大陆免代理直连！
 *
 * 接口：
 *   GET  /health           -> 健康检查
 *   POST /v1/audio/speech  -> OpenAI 兼容语音合成（返回 audio/mpeg）
 *   POST /api/tts          -> 同上
 *
 * 可选环境变量：
 *   API_KEY -> 设置后需携带 Header: Authorization: Bearer <API_KEY>
 *
 * 本文件同时被页面部署脚本内联成 Pages 的 `_worker.js`：
 *   /api/fanqie/* 由 fanqie/index.js 处理，其余未命中的 GET 交给 env.ASSETS。
 */
// ==== fanqie 下载模块（内联，源码在 tts-server/cloudflare-worker/fanqie/）====
const __FQ = {};
__FQ.sm3 = (function () {
/**
 * 国密 SM3（GB/T 32905-2016）纯 JS 实现，同步返回 32 字节摘要。
 * 番茄阅读协议用 SM3 派生内层密钥、并计算请求哈希，Workers 的 WebCrypto 不提供 SM3。
 */
const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

const rotl = (x, n) => {
  const s = n & 31;
  return s === 0 ? x >>> 0 : ((x << s) | (x >>> (32 - s))) >>> 0;
};
const P0 = x => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const P1 = x => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;

function pad(msg) {
  const len = msg.length;
  const bitLen = len * 8;
  const blocks = Math.floor((len + 8) / 64) + 1;
  const buf = new Uint8Array(blocks * 64);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(blocks * 64 - 4, bitLen >>> 0, false);
  view.setUint32(blocks * 64 - 8, Math.floor(bitLen / 0x100000000), false);
  return buf;
}

function sm3(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = pad(msg);
  const V = IV.slice();
  const W = new Uint32Array(68);
  const W1 = new Uint32Array(64);
  const view = new DataView(buf.buffer);
  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) W[j] = view.getUint32(off + j * 4, false);
    for (let j = 16; j < 68; j++) {
      W[j] = (P1((W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15)) >>> 0) ^ rotl(W[j - 13], 7) ^ W[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) W1[j] = (W[j] ^ W[j + 4]) >>> 0;
    let [A, B, C, D, E, F, G, H] = V;
    for (let j = 0; j < 64; j++) {
      const T = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const SS1 = rotl((rotl(A, 12) + E + rotl(T, j % 32)) >>> 0, 7);
      const SS2 = (SS1 ^ rotl(A, 12)) >>> 0;
      const FF = j < 16 ? (A ^ B ^ C) : ((A & B) | (A & C) | (B & C));
      const GG = j < 16 ? (E ^ F ^ G) : ((E & F) | (~E & G));
      const TT1 = ((FF >>> 0) + D + SS2 + W1[j]) >>> 0;
      const TT2 = ((GG >>> 0) + H + SS1 + W[j]) >>> 0;
      D = C;
      C = rotl(B, 9);
      B = A;
      A = TT1;
      H = G;
      G = rotl(F, 19);
      F = E;
      E = P0(TT2);
    }
    V[0] = (V[0] ^ A) >>> 0;
    V[1] = (V[1] ^ B) >>> 0;
    V[2] = (V[2] ^ C) >>> 0;
    V[3] = (V[3] ^ D) >>> 0;
    V[4] = (V[4] ^ E) >>> 0;
    V[5] = (V[5] ^ F) >>> 0;
    V[6] = (V[6] ^ G) >>> 0;
    V[7] = (V[7] ^ H) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, V[i], false);
  return out;
}

return { sm3 };
})();

__FQ.md5 = (function () {
/**
 * MD5（RFC 1321）纯 JS 实现。番茄签名需要对密钥做 MD5，Workers 的 WebCrypto 不提供 MD5。
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

function md5(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = msg.length;
  const total = ((len + 8) >>> 6) * 64 + 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, (len * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((len * 8) / 0x100000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) >>> 0;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

return { md5 };
})();

__FQ.aes = (function () {
/**
 * AES-128/192/256 CBC + PKCS#7 纯 JS 实现（同步）。
 * 番茄协议里 registerkey / 正文 / Argus 都用 AES-CBC，Workers 上同步实现可保持签名链路简单。
 */
const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d, 0x9a]);

const xtime = a => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r & 0xff;
}

// 状态按 FIPS-197：state[r][c] 对应 block[r + 4c]
function expandKey(key) {
  const Nk = key.length / 4;
  const Nr = Nk + 6;
  const words = [];
  for (let i = 0; i < Nk; i++) words.push(key.slice(i * 4, i * 4 + 4));
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let temp = words[i - 1].slice();
    if (i % Nk === 0) {
      temp = [SBOX[temp[1]] ^ RCON[i / Nk - 1], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]];
    } else if (Nk > 6 && i % Nk === 4) {
      temp = [SBOX[temp[0]], SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]]];
    }
    const prev = words[i - Nk];
    words.push([prev[0] ^ temp[0], prev[1] ^ temp[1], prev[2] ^ temp[2], prev[3] ^ temp[3]]);
  }
  const roundKeys = new Uint8Array(16 * (Nr + 1));
  for (let r = 0; r < 4 * (Nr + 1); r++) roundKeys.set(words[r], r * 4);
  return { roundKeys, Nr };
}

function addRoundKey(state, roundKeys, round) {
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[round * 16 + i];
}

function subBytes(state, table) {
  for (let i = 0; i < 16; i++) state[i] = table[state[i]];
}

function shiftRows(state) {
  const out = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) out[r + 4 * c] = state[r + 4 * ((c + r) % 4)];
  }
  state.set(out);
}

function invShiftRows(state) {
  const out = new Uint8Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) out[r + 4 * ((c + r) % 4)] = state[r + 4 * c];
  }
  state.set(out);
}

function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c;
    const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
    state[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
    state[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
  }
}

function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c;
    const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
    state[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    state[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    state[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    state[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}

function encryptBlock(block, roundKeys, Nr) {
  const state = Uint8Array.from(block);
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round <= Nr; round++) {
    subBytes(state, SBOX);
    shiftRows(state);
    if (round !== Nr) mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  return state;
}

function decryptBlock(block, roundKeys, Nr) {
  const state = Uint8Array.from(block);
  addRoundKey(state, roundKeys, Nr);
  for (let round = Nr - 1; round >= 0; round--) {
    invShiftRows(state);
    subBytes(state, INV_SBOX);
    addRoundKey(state, roundKeys, round);
    if (round !== 0) invMixColumns(state);
  }
  return state;
}

function pkcs7Pad(data, block = 16) {
  const rest = data.length % block;
  const padLen = rest === 0 ? block : block - rest;
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}

function pkcs7Unpad(data) {
  if (!data.length) return data;
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > 16 || padLen > data.length) return data;
  for (let i = data.length - padLen; i < data.length; i++) if (data[i] !== padLen) return data;
  return data.subarray(0, data.length - padLen);
}

function aesCbcEncrypt(data, key, iv) {
  const { roundKeys, Nr } = expandKey(key);
  const plain = pkcs7Pad(data, 16);
  const out = new Uint8Array(plain.length);
  let prev = iv.slice();
  for (let off = 0; off < plain.length; off += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = plain[off + i] ^ prev[i];
    const enc = encryptBlock(block, roundKeys, Nr);
    out.set(enc, off);
    prev = enc;
  }
  return out;
}

function aesCbcDecrypt(data, key, iv) {
  const { roundKeys, Nr } = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = iv.slice();
  for (let off = 0; off < data.length; off += 16) {
    const block = data.subarray(off, off + 16);
    const dec = decryptBlock(block, roundKeys, Nr);
    for (let i = 0; i < 16; i++) out[off + i] = dec[i] ^ prev[i];
    prev = block;
  }
  return pkcs7Unpad(out);
}

return { encryptBlock, decryptBlock, pkcs7Pad, pkcs7Unpad, aesCbcEncrypt, aesCbcDecrypt };
})();

__FQ.sign = (function () {
/**
 * 番茄 App reading 协议签名：X-Khronos / X-Ladon / X-Helios / X-Argus。
 * 算法移植自 fanqie.koplugin（GPL-3.0，源自 fanqie-re/fanqie_sign.py），
 * 只依赖本目录下的 sm3 / aes / md5 纯 JS 实现，可在 Cloudflare Workers 同步执行。
 */
const { sm3 } = __FQ.sm3;
const { md5 } = __FQ.md5;
const { aesCbcEncrypt } = __FQ.aes;
const AID = 1967;
const LADON_AID = 3019;
const LICENSE_ID = 1611921764;
const SDK_VERSION_STR = 'v04.04.05-ov-android';
const SDK_VERSION = 134744640;
const SIGN_KEY = hexToBytes('ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c');
const INNER_SALT = new Uint8Array([0xf2, 0x81, 0x61, 0x6f]);
const SIMON_Z = 0x3dc94c3a046d678bn;
const MASK64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}
function base64Decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = B64.indexOf(clean[i + 2]);
    const c3 = B64.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) break;
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}
function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function pkcs7(data, block = 16) {
  const rest = data.length % block;
  const padLen = rest === 0 ? block : block - rest;
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}
const ror64 = (v, n) => {
  const s = BigInt(n & 63);
  return s === 0n ? v & MASK64 : ((v >> s) | (v << (64n - s))) & MASK64;
};
const rol64 = (v, n) => {
  const s = BigInt(n & 63);
  return s === 0n ? v & MASK64 : ((v << s) | (v >> (64n - s))) & MASK64;
};
function leToU64(bytes, off = 0) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
}
function u64ToLe(v) {
  const out = new Uint8Array(8);
  let x = v & MASK64;
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
// 十进制字符串 ÷ 256 逐位取余，19 位 device_id 也不会丢精度。
function le64FromDecimalString(digits) {
  let s = String(digits).replace(/^0+/, '') || '0';
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    let rem = 0;
    let q = '';
    for (const ch of s) {
      const cur = rem * 10 + (ch.charCodeAt(0) - 48);
      const d = Math.floor(cur / 256);
      rem = cur - d * 256;
      if (q.length || d > 0) q += String(d);
    }
    out[i] = rem;
    s = q || '0';
  }
  return out;
}

// ---------- protobuf ----------
function varint(v) {
  let n = BigInt(v) & 0xffffffffn;
  const out = [];
  while (n >= 0x80n) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return new Uint8Array(out);
}
const pbField = (idx, wire, payload) => concat(varint((BigInt(idx) << 3n) | BigInt(wire)), payload);
const pbVarint = (idx, val) => pbField(idx, 0, varint(val));
const pbBytes = (idx, data) => pbField(idx, 2, concat(varint(data.length), data));
const pbStr = (idx, s) => pbBytes(idx, encoder.encode(String(s)));
const u32Shl = (v, n) => ((v * Math.pow(2, n)) % 0x100000000) >>> 0;

// ---------- Ladon / Helios ----------
function buildLadonTable(md5HexAscii) {
  const table = new Uint8Array(288);
  for (let i = 0; i < 32; i++) table[i] = md5HexAscii.charCodeAt(i);
  let b0 = leToU64(table, 0);
  let b1 = leToU64(table, 8);
  const queue = [leToU64(table, 16), leToU64(table, 24)];
  for (let i = 0; i <= 0x21; i++) {
    const x9 = b0;
    let x8 = (ror64(b1, 8) + x9) & MASK64;
    x8 ^= BigInt(i);
    queue.push(x8);
    x8 = (x8 ^ ror64(x9, 61)) & MASK64;
    table.set(u64ToLe(x8), (i + 1) * 8);
    b0 = x8;
    b1 = queue.shift();
  }
  return table;
}
function encryptLadonBlock(table, block) {
  let d0 = leToU64(block, 0);
  let d1 = leToU64(block, 8);
  for (let i = 0; i <= 0x21; i++) {
    const h = leToU64(table, i * 8);
    d1 = (h ^ ((d0 + ror64(d1, 8)) & MASK64)) & MASK64;
    d0 = (d1 ^ ror64(d0, 0x3d)) & MASK64;
  }
  return concat(u64ToLe(d0), u64ToLe(d1));
}
function encryptLadon(khronos, random4) {
  const data = encoder.encode(`${khronos}-${LICENSE_ID}-${LADON_AID}`);
  const md5Hex = bytesToHex(md5(concat(random4, encoder.encode(String(AID)))));
  const table = buildLadonTable(md5Hex);
  const padded = pkcs7(data, 16);
  const parts = [];
  for (let i = 0; i < padded.length; i += 16) parts.push(encryptLadonBlock(table, padded.subarray(i, i + 16)));
  return base64Encode(concat(random4, ...parts));
}

// ---------- SIMON ----------
function deriveInnerKey() {
  return sm3(concat(SIGN_KEY, INNER_SALT, SIGN_KEY));
}
function simonKeyExpansion(key4) {
  const keys = new Array(72);
  for (let i = 0; i < 4; i++) keys[i] = key4[i];
  for (let i = 4; i < 72; i++) {
    let tmp = (ror64(keys[i - 1], 3) ^ keys[i - 3]) & MASK64;
    tmp = (tmp ^ ror64(tmp, 1)) & MASK64;
    const zbit = (SIMON_Z >> BigInt((i - 4) % 62)) & 1n;
    keys[i] = ((~keys[i - 4]) ^ tmp ^ zbit ^ 3n) & MASK64;
  }
  return keys;
}
function simonEncryptBlock(block, roundKeys) {
  let x = leToU64(block, 0);
  let y = leToU64(block, 8);
  for (let i = 0; i < 72; i++) {
    const tmp = x;
    const f = rol64(y, 1) & rol64(y, 8);
    x = y;
    y = (tmp ^ f ^ rol64(y, 2) ^ roundKeys[i]) & MASK64;
  }
  return concat(u64ToLe(x), u64ToLe(y));
}
function simonEncrypt(data, key32) {
  const key4 = [leToU64(key32, 0), leToU64(key32, 8), leToU64(key32, 16), leToU64(key32, 24)];
  const rks = simonKeyExpansion(key4);
  const parts = [];
  for (let i = 0; i < data.length; i += 16) parts.push(simonEncryptBlock(data.subarray(i, i + 16), rks));
  return concat(...parts);
}
// 前置 8 字节自异或后再整体反转（字节级混淆）
function encryptEncPb(data, length) {
  const d = Uint8Array.from(data.subarray(0, length));
  const xorArray = Uint8Array.from(d.subarray(0, 8));
  for (let i = 8; i < length; i++) d[i] ^= xorArray[i % 8];
  return d.reverse();
}

// ---------- Argus ----------
function encryptArgus(query, timestamp, deviceId, opts = {}) {
  const versionName = opts.versionName || '7.3.7.33';
  const deviceType = opts.deviceType || 'P30';
  const osVersion = opts.osVersion || '12';
  let randVal = opts.randVal;
  if (randVal === undefined) {
    const r = opts.random4 || new Uint8Array(4);
    randVal = ((((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0) & 0x7fffffff);
  }
  const bodyHash = sm3(new Uint8Array(16)).subarray(0, 6);
  const queryHash = (query ? sm3(encoder.encode(query)) : sm3(new Uint8Array(16))).subarray(0, 6);
  const sub = concat(
    pbStr(1, deviceType),
    pbStr(2, osVersion),
    pbStr(3, 'googleplay'),
    pbVarint(4, 0x48000000),
  );
  const pb = concat(
    pbVarint(1, u32Shl(0x20200929, 1)),
    pbVarint(2, 2),
    pbVarint(3, randVal),
    pbStr(4, String(AID)),
    pbStr(5, String(deviceId)),
    pbStr(6, String(LICENSE_ID)),
    pbStr(7, versionName),
    pbStr(8, SDK_VERSION_STR),
    pbVarint(9, SDK_VERSION),
    pbBytes(10, new Uint8Array(8)),
    pbVarint(11, 0),
    pbVarint(12, u32Shl(timestamp, 1)),
    pbBytes(13, bodyHash),
    pbBytes(14, queryHash),
    pbVarint(20, 738),
    pbBytes(23, sub),
  );
  const encPb = simonEncrypt(pkcs7(pb, 16), deriveInnerKey());
  const prefix = new Uint8Array([0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff]);
  const inner = encryptEncPb(concat(prefix, encPb), encPb.length + 8);
  const head = new Uint8Array([0xa6, 0x6e, 0xad, 0x9f, 0x77, 0x01, 0xd0, 0x0c, 0x18]);
  const buf = concat(head, inner, encoder.encode('ao'));
  const aesKey = md5(SIGN_KEY.subarray(0, 16));
  const aesIv = md5(SIGN_KEY.subarray(16, 32));
  const encrypted = aesCbcEncrypt(buf, aesKey, aesIv);
  return base64Encode(concat(new Uint8Array([0xf2, 0x81]), encrypted));
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function signHeaders(queryString, deviceId, opts = {}) {
  const khronos = opts.khronos || Math.floor(Date.now() / 1000);
  return {
    'X-Khronos': String(khronos),
    'X-Ladon': encryptLadon(khronos, opts.ladonRandom4 || randomBytes(4)),
    'X-Helios': encryptLadon(khronos, opts.heliosRandom4 || randomBytes(4)),
    'X-Argus': encryptArgus(queryString, khronos, deviceId, {
      versionName: opts.versionName,
      deviceType: opts.deviceType,
      osVersion: opts.osVersion,
      randVal: opts.randVal,
      random4: opts.argusRandom4,
    }),
  };
}

return { hexToBytes, bytesToHex, base64Encode, base64Decode, le64FromDecimalString, encryptLadon, encryptArgus, randomBytes, signHeaders };
})();

__FQ.fanqie = (function () {
/**
 * 番茄小说取书：搜索 / 详情 / 目录 / 正文。
 * 正文走番茄官方 App reading 协议（设备注册 → registerkey → batch_full → AES 解密 → gzip 解压），
 * 目录走网页接口（免登录），搜索走 App 搜索接口。
 */
const { signHeaders, base64Encode, base64Decode, hexToBytes, bytesToHex, le64FromDecimalString, randomBytes } = __FQ.sign;
const { aesCbcDecrypt, aesCbcEncrypt } = __FQ.aes;
const HOST = 'api5-normal-sinfonlinec.fqnovel.com';
const BATCH_FULL_PATH = '/reading/reader/batch_full/v';
const REGISTERKEY_PATH = '/reading/crypt/registerkey';
const DETAIL_PATH = '/reading/bookapi/detail/v/';
const SEARCH_PATH = '/reading/bookapi/search/page/v/';
const REGISTER_HOST = 'log.snssdk.com';
const REGISTER_PATH = '/service/2/device_register/';
const HARDCODED_KEY = hexToBytes('ac25c67ddd8f38c1b37a2348828e222e');
const AID = 1967;
const BATCH_LIMIT = 6; // 服务端一次最多返回 6 章
const encoder = new TextEncoder();

const PROFILE = {
  channel: '43536163a',
  version_code: '73733',
  version_name: '7.3.7.33',
  device_type: 'P30',
  device_brand: 'HUAWEI',
  language: 'zh',
  os_api: '31',
  os_version: '12',
  resolution: '1280*720',
  dpi: '240',
  host_abi: 'arm64-v8a',
  rom_version: 'S643.217451.03386707',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 查询串 ----------
const URL_SAFE = /[A-Za-z0-9_.!~*'()-]/;
function urlEncode(value) {
  let out = '';
  for (const byte of encoder.encode(String(value))) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && URL_SAFE.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
const ORDER = ['iid', 'device_id', 'ac', 'channel', 'aid', 'app_name', 'version_code', 'version_name',
  'device_platform', 'os', 'ssmix', 'device_type', 'device_brand', 'language', 'os_api', 'os_version',
  'manifest_version_code', 'resolution', 'dpi', 'update_version_code', '_rticket', 'host_abi',
  'cdid', 'openudid', 'item_ids', 'key_register_ts', 'book_id', 'req_type'];

function encodeQuery(params) {
  const seen = new Set();
  const parts = [];
  const add = (k, v) => {
    if (v === undefined || v === null || seen.has(k)) return;
    seen.add(k);
    let ev;
    if (k === 'item_ids') ev = urlEncode(v).replace(/%2C/g, ',');
    else ev = urlEncode(v).replace(/%2A/g, '*').replace(/%2B/g, '+');
    parts.push(`${urlEncode(k)}=${ev}`);
  };
  for (const k of ORDER) if (params[k] !== undefined && params[k] !== null) add(k, params[k]);
  for (const [k, v] of Object.entries(params)) add(k, v);
  return parts.join('&');
}

function buildCommonQuery(device, tsMs = Date.now()) {
  return {
    iid: String(device.install_id),
    device_id: String(device.device_id),
    ac: 'wifi',
    channel: device.channel || PROFILE.channel,
    aid: String(AID),
    app_name: 'novelapp',
    version_code: String(device.version_code || PROFILE.version_code),
    version_name: String(device.version_name || PROFILE.version_name),
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    device_type: device.device_type || PROFILE.device_type,
    device_brand: device.device_brand || PROFILE.device_brand,
    language: device.language || PROFILE.language,
    os_api: String(device.os_api || PROFILE.os_api),
    os_version: String(device.os_version || PROFILE.os_version),
    manifest_version_code: String(device.version_code || PROFILE.version_code),
    resolution: device.resolution || PROFILE.resolution,
    dpi: String(device.dpi || PROFILE.dpi),
    update_version_code: String(device.version_code || PROFILE.version_code),
    _rticket: String(tsMs),
    host_abi: device.host_abi || PROFILE.host_abi,
    cdid: device.cdid || '',
    openudid: device.openudid || '',
  };
}

function buildBatchFullQuery(device, bookId, itemIds, tsMs) {
  return {
    ...buildCommonQuery(device, tsMs),
    item_ids: itemIds.join(','),
    key_register_ts: '0',
    book_id: String(bookId),
    req_type: '1',
  };
}

function buildUnsignedHeaders(device, tsMs) {
  const vc = device.version_code || PROFILE.version_code;
  const rom = String(device.rom_version || PROFILE.rom_version).split('+')[0];
  const ua = `com.dragon.read.oversea.gp/${vc} (Linux; U; Android ${device.os_version || PROFILE.os_version}; zh_CN; ${device.device_type || PROFILE.device_type}; Build/${rom};tt-ok/3.12.13.4-tiktok)`;
  return {
    'User-Agent': ua,
    Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'Accept-Encoding': 'identity',
    'sdk-version': '2',
    'passport-sdk-version': '50564',
    lc: '101',
    'x-tt-store-region': 'cn-zj',
    'x-tt-store-region-src': 'did',
    'x-vc-bdturing-sdk-version': '3.7.2.cn',
    'x-xs-from-web': '0',
    'X-Ss-Req-Ticket': String(tsMs),
    'x-reading-request': `${tsMs}-${bytesToHex(randomBytes(4))}`,
    Cookie: `store-region=cn-zj; store-region-src=did; install_id=${device.install_id}`,
  };
}

function uuid4() {
  const b = [...randomBytes(16)];
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(new Uint8Array(b));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------- 设备身份 ----------
async function registerDevice(fetcher) {
  const profile = { ...PROFILE };
  profile.cdid = uuid4();
  profile.openudid = bytesToHex(randomBytes(8));
  profile.clientudid = uuid4();
  const now = Date.now();
  const qs = [
    'ac=wifi', `channel=${profile.channel}`, 'aid=1967', 'app_name=novelapp',
    `version_code=${profile.version_code}`, `version_name=${profile.version_name}`,
    'device_platform=android', 'ssmix=a', `device_type=${profile.device_type}`,
    `device_brand=${profile.device_brand}`, `language=${profile.language}`,
    `os_api=${profile.os_api}`, `os_version=${profile.os_version}`,
    `openudid=${profile.openudid}`, `manifest_version_code=${profile.version_code}`,
    `resolution=${profile.resolution}`, `dpi=${profile.dpi}`,
    `update_version_code=${profile.version_code}`, `_rticket=${now}`, `cdid=${profile.cdid}`,
  ].join('&');
  const body = {
    magic_tag: 'ss_app_log',
    header: {
      display_name: '番茄小说', update_version_code: Number(profile.version_code),
      manifest_version_code: Number(profile.version_code), aid: AID, channel: profile.channel,
      package: 'com.dragon.read', app_version: profile.version_name,
      version_code: Number(profile.version_code), sdk_version: '3.7.2.cn', os: 'Android',
      os_version: profile.os_version, os_api: Number(profile.os_api), device_model: profile.device_type,
      device_brand: profile.device_brand, device_manufacturer: profile.device_brand,
      cpu_abi: profile.host_abi, density_dpi: Number(profile.dpi),
      resolution: profile.resolution.replace('*', 'x'), language: profile.language, timezone: 8,
      access: 'wifi', not_request_sender: 0, rom_version: profile.rom_version, cdid: profile.cdid,
      openudid: profile.openudid, clientudid: profile.clientudid, region: 'CN',
      tz_name: 'Asia/Shanghai', tz_offset: 28800, sim_region: 'cn', req_id: uuid4(),
      apk_first_install_time: now - 86400000, is_system_app: 0, sdk_flavor: 'china',
    },
    _gen_time: now,
  };
  const ua = `com.dragon.read/${profile.version_code} (Linux; U; Android ${profile.os_version}; zh_CN; ${profile.device_type}; Build/${profile.rom_version.split('+')[0]};tt-ok/3.12.13.4-tiktok)`;
  const res = await fetcher(`https://${REGISTER_HOST}${REGISTER_PATH}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': ua, 'Accept-Encoding': 'identity' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`设备注册失败 HTTP ${res.status}`);
  const text = await res.text();
  const quoted = text.replace(/("(?:device_id|install_id)"\s*:\s*)(\d{8,})/g, '$1"$2"');
  const data = JSON.parse(quoted);
  const deviceId = String(data.device_id_str || data.device_id || '');
  const installId = String(data.install_id_str || data.install_id || '');
  if (!deviceId || !installId) throw new Error('设备注册未返回 device_id（番茄接口可能被风控）');
  profile.device_id = deviceId;
  profile.install_id = installId;
  return profile;
}

// 单 isolate 内复用设备身份与 v1_key，冷启动时才重新注册。
const cache = { device: null, v1Key: null, v1At: 0 };
const V1_TTL = 6 * 86400000;

async function getDevice() {
  if (cache.device) return cache.device;
  cache.device = await registerDevice(fetch);
  return cache.device;
}

async function signedCall(path, params, body, { cookie = '' } = {}) {
  const device = await getDevice();
  const tsMs = Date.now();
  const qs = encodeQuery(params);
  const headers = buildUnsignedHeaders(device, tsMs);
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = `${headers.Cookie}; ${cookie}`;
  Object.assign(headers, signHeaders(qs, device.device_id, {
    khronos: Math.floor(tsMs / 1000),
    versionName: device.version_name,
    deviceType: device.device_type,
    osVersion: device.os_version,
  }));
  headers['X-Ss-Req-Ticket'] = String(tsMs);
  const res = await fetch(`https://${HOST}${path}?${qs}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`番茄接口 HTTP ${res.status}`);
  const text = await res.text();
  if (!text) throw new Error('番茄接口返回空响应（设备身份可能被风控，稍后重试）');
  const data = JSON.parse(text);
  if (Number(data.code) !== 0 || !data.data) {
    throw new Error(`番茄接口失败 code=${data.code} ${data.message || data.msg || ''}`.trim());
  }
  return data.data;
}

async function getV1Key(force = false) {
  if (!force && cache.v1Key && Date.now() - cache.v1At < V1_TTL) return cache.v1Key;
  const device = await getDevice();
  const payload = new Uint8Array(16);
  payload.set(le64FromDecimalString(device.device_id), 0);
  const ivText = bytesToHex(randomBytes(16)).slice(0, 16);
  const iv = encoder.encode(ivText);
  const ct = aesCbcEncrypt(payload, HARDCODED_KEY, iv);
  const content = base64Encode(new Uint8Array([...iv, ...ct]));
  const data = await signedCall(REGISTERKEY_PATH, buildCommonQuery(device), { content, keyver: 1 });
  if (!data.key) throw new Error('registerkey 未返回内容密钥');
  const raw = base64Decode(data.key);
  const plain = aesCbcDecrypt(raw.subarray(16), HARDCODED_KEY, raw.subarray(0, 16));
  cache.v1Key = bytesToHex(plain).toUpperCase();
  cache.v1At = Date.now();
  return cache.v1Key;
}

// ---------- 解密 ----------
async function gunzipBytes(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}
async function inflateBytes(bytes, format) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function decompress(bytes, compressStatus) {
  if (!bytes || !bytes.length) return bytes;
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const isZlib = bytes[0] === 0x78;
  if (!(Number(compressStatus) > 0 || isGzip || isZlib)) return bytes;
  if (isGzip) return gunzipBytes(bytes);
  if (isZlib) return (await inflateBytes(bytes, 'deflate')) || bytes;
  return (await inflateBytes(bytes, 'deflate-raw')) || bytes;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', hellip: '…', mdash: '—' };
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** 番茄正文是 App 端富文本片段，转成纯文本段落。 */
function markupToText(html, title = '') {
  let s = String(html || '');
  if (!s.trim()) return '';
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<header[\s\S]*?<\/header>/gi, '');
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  s = s.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '');
  s = s.replace(/<img[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|li|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  const lines = s.split('\n')
    .map(line => line.replace(/[\s\u3000\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => line !== title.trim())
    // 版权页里夹带的 CSS 片段没有阅读价值
    .filter(line => !/^[.#@][\w-]+\s*\{/.test(line) && !/^[a-z-]+\s*:\s*[^;]+;?$/i.test(line));
  return lines.join('\n\n');
}

// ---------- 正文 ----------
function safeTitle(item) {
  return String(item?.title || '').trim();
}

async function fetchBatch(bookId, itemIds, v1Key, cookie) {
  const data = await signedCall(BATCH_FULL_PATH, buildBatchFullQuery(await getDevice(), bookId, itemIds), null, { cookie });
  const out = [];
  for (const id of itemIds) {
    let item = data[id] ?? data[String(id)];
    if (Array.isArray(item)) item = item[0];
    if (!item) {
      out.push({ id, ok: false, reason: 'empty', title: '', text: '' });
      continue;
    }
    const contentStr = String(item.content ?? '');
    if (!contentStr || contentStr === 'Invalid') {
      out.push({ id, ok: false, reason: 'locked', title: safeTitle(item), text: '' });
      continue;
    }
    try {
      let raw;
      if (Number(item.crypt_status || 0) === 0 && v1Key) {
        const bin = base64Decode(contentStr);
        raw = aesCbcDecrypt(bin.subarray(16), hexToBytes(v1Key.toLowerCase()), bin.subarray(0, 16));
      } else {
        raw = encoder.encode(contentStr);
      }
      const plain = await decompress(raw, item.compress_status);
      const text = markupToText(new TextDecoder('utf-8').decode(plain), safeTitle(item));
      out.push({ id, ok: Boolean(text), reason: text ? '' : 'empty', title: safeTitle(item), text });
    } catch {
      out.push({ id, ok: false, reason: 'decrypt', title: safeTitle(item), text: '' });
    }
  }
  return out;
}

/** 换一台匿名设备身份：旧设备的配额被风控后继续抓取要靠它。 */
function rotateDevice() {
  cache.device = null;
  cache.v1Key = null;
  cache.v1At = 0;
}

const isEmptyish = row => !row.ok && (row.reason === 'empty' || row.reason === 'locked');

/**
 * 取一页章节（≤6 章）。语义上保持「一页一请求」，让 Workers 单次 CPU 开销可控；
 * 节奏、换设备、整体重试由调用方（前端或测试脚本）决定。
 * @param {boolean} fresh 先换一台设备身份再取，用于旧设备被风控后继续
 */
async function fetchChapters(bookId, itemIds, { cookie = '', fresh = false } = {}) {
  const ids = itemIds.map(String).filter(id => /^\d+$/.test(id));
  if (!ids.length) throw new Error('缺少章节 ID');
  if (fresh) rotateDevice();
  let v1Key = await getV1Key();
  let rows;
  try {
    rows = await fetchBatch(bookId, ids, v1Key, cookie);
  } catch (err) {
    // 设备或密钥失效：换设备后再试一次
    rotateDevice();
    v1Key = await getV1Key(true);
    rows = await fetchBatch(bookId, ids, v1Key, cookie);
  }
  // 服务端偶尔少给几章：单独补一次
  for (const row of rows.filter(isEmptyish)) {
    try {
      const [retryRow] = await fetchBatch(bookId, [row.id], v1Key, cookie);
      if (retryRow?.ok) {
        const index = rows.findIndex(item => item.id === row.id);
        rows[index] = retryRow;
      }
    } catch {
      // 保持失败标记，前端会写明「未能获取」
    }
    await sleep(220);
  }

  // 还有空章：多半是这台设备被短时限流，换一台设备再补一次
  const left = rows.filter(isEmptyish);
  if (left.length) {
    rotateDevice();
    try {
      const retryKey = await getV1Key(true);
      const retryRows = await fetchBatch(bookId, left.map(row => row.id), retryKey, cookie);
      for (const retryRow of retryRows) {
        if (!retryRow?.ok) continue;
        const index = rows.findIndex(item => item.id === retryRow.id);
        if (index >= 0) rows[index] = retryRow;
      }
    } catch {
      // 换设备也失败就返回现状，客户端会做延迟补漏
    }
  }
  return rows;
}

// ---------- 目录 / 详情 / 搜索 ----------
async function webJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Referer: 'https://fanqienovel.com/',
    },
  });
  if (!res.ok) throw new Error(`目录接口 HTTP ${res.status}`);
  return res.json();
}

async function loadCatalog(bookId) {
  if (!/^\d+$/.test(String(bookId))) throw new Error('书籍 ID 无效');
  const json = await webJson(`https://fanqienovel.com/api/reader/directory/detail?bookId=${bookId}`);
  const data = json?.data;
  if (!data) throw new Error('目录接口返回异常');
  const titles = new Map();
  const volumes = [];
  for (const volume of data.chapterListWithVolume || []) {
    if (!Array.isArray(volume)) continue;
    for (const chapter of volume) {
      if (!chapter?.itemId) continue;
      titles.set(String(chapter.itemId), {
        title: String(chapter.title || '').trim(),
        volume: String(chapter.volume_name || '').trim(),
        locked: Boolean(chapter.isChapterLock || Number(chapter.needPay) > 0),
      });
      if (chapter.volume_name && !volumes.includes(chapter.volume_name)) volumes.push(chapter.volume_name);
    }
  }
  const ids = (data.allItemIds || []).map(String);
  const chapters = ids.map((id, index) => ({
    id,
    title: titles.get(id)?.title || `第${index + 1}章`,
    volume: titles.get(id)?.volume || '',
    locked: titles.get(id)?.locked || false,
  }));
  return { chapters, volumes };
}

async function loadBookDetail(bookId, { cookie = '' } = {}) {
  const data = await signedCall(DETAIL_PATH, { ...buildCommonQuery(await getDevice()), book_id: String(bookId) }, null, { cookie });
  const pick = (...keys) => {
    for (const key of keys) if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
    return '';
  };
  return {
    id: String(bookId),
    title: String(pick('book_name', 'bookName', 'name')),
    author: String(pick('author', 'author_name', 'authorName')),
    abstract: String(pick('abstract', 'description', 'book_abstract')),
    category: String(pick('category', 'category_name')),
    cover: String(pick('thumb_url', 'expand_thumb_url', 'thumb_uri')),
    words: String(pick('word_number', 'wordNumber')),
    status: String(pick('creation_status', 'creationStatus')),
    lastChapter: String(pick('last_chapter_title', 'lastChapterTitle')),
    serialCount: String(pick('serial_count', 'serialCount')),
  };
}

async function searchBooks(keyword, count = 12, { cookie = '' } = {}) {
  const q = String(keyword || '').trim();
  if (!q) throw new Error('请输入书名或作者');
  const data = await signedCall(SEARCH_PATH, {
    ...buildCommonQuery(await getDevice()),
    query: q,
    offset: '0',
    count: String(Math.min(20, Math.max(1, count))),
  }, null, { cookie });
  const items = [];
  if (Array.isArray(data)) items.push(...data);
  else if (typeof data === 'object') {
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value && typeof value === 'object') items.push(value);
    }
  }
  const seen = new Set();
  const books = [];
  for (const item of items) {
    const book = item?.book_data?.[0] || item?.book_data || item?.book_info;
    if (!book?.book_id) continue;
    const id = String(book.book_id);
    if (seen.has(id)) continue;
    seen.add(id);
    books.push({
      id,
      title: String(book.book_name || item?.search_high_light?.title?.text || '未命名'),
      author: String(book.author || ''),
      abstract: String(book.abstract || '').slice(0, 220),
      category: String(book.category || ''),
      words: String(book.word_number || ''),
      chapters: String(book.serial_count || ''),
      status: String(book.creation_status || '') === '1' ? '已完结' : '连载中',
    });
  }
  return books;
}

function parseBookId(input) {
  const text = String(input || '').trim();
  if (/^\d{6,}$/.test(text)) return text;
  const match = text.match(/(?:page|reader)\/(\d{6,})/) || text.match(/book_id=(\d{6,})/) || text.match(/(\d{15,20})/);
  return match ? match[1] : '';
}

return { HOST, BATCH_FULL_PATH, REGISTERKEY_PATH, DETAIL_PATH, SEARCH_PATH, PROFILE, urlEncode, encodeQuery, buildCommonQuery, buildBatchFullQuery, registerDevice, getDevice, signedCall, getV1Key, rotateDevice, gunzipBytes, markupToText, fetchChapters, loadCatalog, loadBookDetail, searchBooks, parseBookId };
})();

__FQ.router = (function () {
/**
 * 番茄小说下载 —— 后端路由模块（适配 _worker.js / Advanced Mode）
 *
 * 用法：在 _worker.js 里
 *   import { handleFanqie } from './fanqie/index.js';
 *   ...
 *   const url = new URL(request.url);
 *   if (url.pathname === '/api/fanqie' || url.pathname.startsWith('/api/fanqie/')) {
 *     return handleFanqie(request, env);
 *   }
 *   // 其余请求继续走原来的逻辑 / env.ASSETS.fetch(request)
 *
 * 路由：
 *   GET  /api/fanqie/health                    探活
 *   GET  /api/fanqie/search?q=&count=          搜索
 *   GET  /api/fanqie/book?id=                  详情 + 目录
 *   POST /api/fanqie/chapters  { book, items } 正文（一次最多 6 章，可带 fresh:1 换设备）
 */
const { searchBooks, loadCatalog, loadBookDetail, fetchChapters, parseBookId } = __FQ.fanqie;
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Fanqie-Cookie',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { ...cors(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const fail = (message, status = 502) => json({ ok: false, error: message }, status);

async function handleFanqie(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

  const url = new URL(request.url);
  const rest = url.pathname.replace(/^.*\/api\/fanqie\/?/, '');
  const route = rest.replace(/\/+$/, '') || 'health';
  const cookie = request.headers.get('X-Fanqie-Cookie') || env.FANQIE_COOKIE || '';

  try {
    if (route === 'health') {
      return json({ ok: true, engine: 'fanqie-reading-proxy', version: 1 });
    }

    if (route === 'search') {
      const keyword = url.searchParams.get('q') || '';
      const count = Number(url.searchParams.get('count') || 12);
      const items = await searchBooks(keyword, count, { cookie });
      return json({ ok: true, items });
    }

    if (route === 'book') {
      const id = parseBookId(url.searchParams.get('id') || '');
      if (!id) return fail('书籍 ID 无效，请粘贴 fanqienovel.com/page/ 后面的数字', 400);
      const [detail, catalog] = await Promise.all([
        loadBookDetail(id, { cookie }).catch(() => null),
        loadCatalog(id),
      ]);
      return json({
        ok: true,
        book: { ...(detail || { id, title: '' }), id, chapters: catalog.chapters, volumes: catalog.volumes },
      });
    }

    if (route === 'chapters') {
      const body = request.method === 'POST'
        ? await request.json().catch(() => ({}))
        : Object.fromEntries(url.searchParams);
      const bookId = parseBookId(body.book || body.bookId || '');
      const items = Array.isArray(body.items) ? body.items : String(body.items || '').split(',');
      if (!bookId || !items.length) return fail('缺少 book 或 items 参数', 400);
      const fresh = body.fresh === true || body.fresh === '1' || url.searchParams.get('fresh') === '1';
      const chapters = await fetchChapters(bookId, items, { cookie, fresh });
      return json({ ok: true, chapters });
    }

    return fail(`未知接口 ${route}`, 404);
  } catch (err) {
    return fail(err?.message || '番茄接口访问失败');
  }
}


return { handleFanqie };
})();
const { handleFanqie } = __FQ.router;
// ==== fanqie 模块结束 ====

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const EDGE_WS_HTTPS_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const WIN_EPOCH_SECONDS = 11644473600;
const TOKEN_WINDOW_SECONDS = 300;

// Sec-MS-GEC v2 哈希实现（移植自 rany2/edge-tts drm.py）
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_PREFIX_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_PREFIX_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ROUND_14_ADJUSTMENT = 0xc9dc06a7;
const SHA256_PREFIX_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.map(
  (c, i) => (i === 14 ? SHA256_ROUND_14_ADJUSTMENT : c),
);
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const rotr = (v, b) => ((v >>> b) | (v << (32 - b))) >>> 0;
const rol16 = v => ((v << 16) | (v >>> 16)) >>> 0;
const sigma0 = v => (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0;
const sigma1 = v => (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0;

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
  }
}

function compress(state, words, firstRound = 0) {
  const constants = firstRound === 14 ? SHA256_PREFIX_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = firstRound; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + constants[i] + words[i]) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)))) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function prefixBlockState(payload) {
  const words = new Array(14).fill(0);
  words.push((payload[0] << 16) | (payload[1] << 8) | payload[2]);
  words.push(((payload[3] << 24) | (payload[4] << 16) | (payload[5] << 8) | payload[6]) >>> 0);
  for (let i = 16; i < 30; i++) {
    let value = SHA256_PREFIX_SCHEDULE[i - 16] + (
      i === 16 ? ((sigma1(words[14]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0) : sigma1(words[i - 2])
    );
    if (i >= 21) value += words[i - 7];
    if (i === 29) value += (sigma0(words[14]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0;
    words.push(value >>> 0);
  }
  words.push(
    (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ROUND_14_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0,
  );
  expandSchedule(words, 31);
  const working = compress(SHA256_PREFIX_STATE, words, 14);
  return SHA256_INITIAL.map((v, i) => (v + working[i]) >>> 0);
}

function sha256Digest(payload) {
  const messageLength = 57 + payload.length;
  const zeroPadding = (((55 - messageLength) % 64) + 64) % 64;
  const tail = new Uint8Array(payload.length - 7 + 1 + zeroPadding + 8);
  tail.set(payload.subarray(7));
  tail[payload.length - 7] = 0x80;
  const tailView = new DataView(tail.buffer);
  const bitLength = messageLength * 8;
  tailView.setUint32(tail.length - 8, Math.floor(bitLength / 2 ** 32));
  tailView.setUint32(tail.length - 4, bitLength >>> 0);

  let state = prefixBlockState(payload);
  for (let offset = 0; offset < tail.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(tailView.getUint32(offset + i * 4));
    expandSchedule(words);
    const working = compress(state, words);
    state = state.map((v, i) => (v + working[i]) >>> 0);
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((v, i) => digestView.setUint32(i * 4, v));
  return digest;
}

function cs64Words(payload) {
  const byteLength = Math.ceil((payload.length + 1) / 8) * 8;
  const bytes = new Uint8Array(byteLength);
  bytes.set(payload, 1);
  const view = new DataView(bytes.buffer);
  const words = [];
  for (let offset = 0; offset < byteLength; offset += 4) words.push(view.getUint32(offset, true));
  return words;
}

function cs64Digest(payload, digest) {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (view.getUint32(0, true) | 1) >>> 0;
  const keyB = (view.getUint32(4, true) | 1) >>> 0;
  const factors = [Math.imul(keyA, CS64_FACTOR) >>> 0, Math.imul(keyB, CS64_FACTOR) >>> 0];
  const terms = CS64_COEFFICIENTS.map(([c], i) => Math.imul(c, factors[i % 2]) >>> 0);
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);

  cs64Words(payload).forEach((word, i) => {
    const even = i % 2 === 0;
    let term = Math.imul(word, even ? keyA : keyB);
    let offset = Math.imul(rol16(word), even ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term += Math.imul(CS64_ADJUSTMENT0, factors[0]);
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  });

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let q = Math.imul(rol16((offsets[i] + x) >>> 0), 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    q = Math.imul(rol16((offsets[i + 1] + y) >>> 0), 0x1881ce3c) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;

    let t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    t = Math.imul(rol16(t), 0x7c932b89) >>> 0;
    state = Math.imul(rol16(t), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function generateSecMsGec(unixSeconds = Date.now() / 1000) {
  let ticks = unixSeconds + WIN_EPOCH_SECONDS;
  ticks -= ticks % TOKEN_WINDOW_SECONDS;
  ticks *= 1e7;
  const payload = new TextEncoder().encode(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(payload);
  const checksum = new Uint8Array(8);
  const view = new DataView(checksum.buffer);
  cs64Digest(payload, digest).forEach((w, i) => view.setUint32(i * 4, w, true));
  return `${toHex(checksum)}-${toHex(digest)}`;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function normalizeVoiceName(voice) {
  const trimmed = String(voice || 'zh-CN-XiaoxiaoNeural').trim();
  const shortMatch = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(trimmed);
  if (!shortMatch) return trimmed;
  let [, lang, region, name] = shortMatch;
  if (name.includes('-')) {
    const [regionSuffix, ...rest] = name.split('-');
    region += `-${regionSuffix}`;
    name = rest.join('-');
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

function escapeXml(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function speedToRate(speed = 1.0) {
  const clamped = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));
  const pct = Math.round((clamped - 1.0) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sync-Key',
    'Access-Control-Max-Age': '86400',
  };
}

let vaultSchemaReady = false;

async function ensureVaultSchema(db) {
  if (vaultSchemaReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS books (
        vault_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        has_text INTEGER NOT NULL DEFAULT 0,
        text_hash TEXT NOT NULL DEFAULT '',
        encoding TEXT NOT NULL DEFAULT 'gzip',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (vault_id, book_id)
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS book_chunks (
        vault_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        data_b64 TEXT NOT NULL,
        PRIMARY KEY (vault_id, book_id, chunk_idx)
      )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_books_vault_updated ON books (vault_id, updated_at DESC)`,
    ),
  ]);
  vaultSchemaReady = true;
}

async function resolveVaultId(request) {
  const raw = String(request.headers.get('X-Sync-Key') || '').trim();
  if (raw.length < 10) {
    throw Object.assign(new Error('同步码至少需要 10 位字符'), { status: 400 });
  }
  if (/^\d+$/.test(raw)) {
    throw Object.assign(new Error('为防止与他人撞码，同步码不能为纯数字'), { status: 400 });
  }
  const bytes = new TextEncoder().encode(`yeding-vault-v1:${raw}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function validBookId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 160 && !/[\\/\0]/.test(id);
}

async function handleSyncRequest(request, url, env) {
  if (!env?.DB) {
    return Response.json({ error: '云书库尚未绑定 D1 数据库' }, { status: 503, headers: corsHeaders() });
  }
  let vaultId;
  try {
    vaultId = await resolveVaultId(request);
  } catch (err) {
    return Response.json({ error: err.message }, { status: err.status || 400, headers: corsHeaders() });
  }

  try {
    await ensureVaultSchema(env.DB);
    const sub = url.pathname.slice('/api/sync'.length);

    if (sub === '/status' && request.method === 'GET') {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS bookCount, COALESCE(SUM(chunk_count), 0) AS totalChunks
         FROM books WHERE vault_id = ? AND deleted = 0`,
      ).bind(vaultId).first();
      return Response.json(
        {
          ok: true,
          bookCount: Number(row?.bookCount || 0),
          totalChunks: Number(row?.totalChunks || 0),
          serverTime: Date.now(),
        },
        { headers: { ...corsHeaders(), 'Cache-Control': 'no-store' } },
      );
    }

    if (sub === '/books' && request.method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT book_id, meta_json, has_text, text_hash, encoding, chunk_count, updated_at, deleted
         FROM books WHERE vault_id = ? ORDER BY updated_at DESC`,
      ).bind(vaultId).all();
      const books = (results || []).map(r => {
        let meta = null;
        try { meta = JSON.parse(r.meta_json); } catch {}
        return {
          bookId: r.book_id,
          meta,
          hasText: Boolean(r.has_text),
          textHash: r.text_hash || '',
          encoding: r.encoding || 'gzip',
          chunkCount: Number(r.chunk_count || 0),
          updatedAt: Number(r.updated_at || 0),
          deleted: Boolean(r.deleted),
        };
      });
      return Response.json(
        { ok: true, serverTime: Date.now(), books },
        { headers: { ...corsHeaders(), 'Cache-Control': 'no-store' } },
      );
    }

    const metaMatch = /^\/books\/([^/]+)\/meta$/.exec(sub);
    if (metaMatch && (request.method === 'PUT' || request.method === 'POST')) {
      const bookId = decodeURIComponent(metaMatch[1]);
      if (!validBookId(bookId)) {
        return Response.json({ error: '无效的书籍 ID' }, { status: 400, headers: corsHeaders() });
      }
      const body = await request.json();
      const updatedAt = Math.max(1, Number(body.updatedAt) || Date.now());
      const deleted = Boolean(body.deleted);
      const metaJson = JSON.stringify(body.meta || { id: bookId });
      if (metaJson.length > 512 * 1024) {
        return Response.json({ error: '书籍元数据过大' }, { status: 413, headers: corsHeaders() });
      }
      if (deleted) {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO books (vault_id, book_id, meta_json, has_text, text_hash, encoding, chunk_count, updated_at, deleted)
             VALUES (?, ?, ?, 0, '', 'gzip', 0, ?, 1)
             ON CONFLICT(vault_id, book_id) DO UPDATE SET
               meta_json = excluded.meta_json,
               has_text = 0,
               text_hash = '',
               chunk_count = 0,
               updated_at = excluded.updated_at,
               deleted = 1`,
          ).bind(vaultId, bookId, metaJson, updatedAt),
          env.DB.prepare(`DELETE FROM book_chunks WHERE vault_id = ? AND book_id = ?`).bind(vaultId, bookId),
        ]);
      } else {
        await env.DB.prepare(
          `INSERT INTO books (vault_id, book_id, meta_json, updated_at, deleted)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(vault_id, book_id) DO UPDATE SET
             meta_json = excluded.meta_json,
             updated_at = CASE WHEN excluded.updated_at >= books.updated_at THEN excluded.updated_at ELSE books.updated_at END,
             deleted = 0`,
        ).bind(vaultId, bookId, metaJson, updatedAt).run();
      }
      return Response.json({ ok: true, bookId, updatedAt, deleted }, { headers: corsHeaders() });
    }

    const chunkMatch = /^\/books\/([^/]+)\/chunk\/(\d+)$/.exec(sub);
    if (chunkMatch) {
      const bookId = decodeURIComponent(chunkMatch[1]);
      const idx = Number(chunkMatch[2]);
      if (!validBookId(bookId) || !Number.isInteger(idx) || idx < 0 || idx > 500) {
        return Response.json({ error: '无效的分片参数' }, { status: 400, headers: corsHeaders() });
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.json();
        const dataB64 = String(body.dataB64 || '');
        if (!dataB64 || dataB64.length > 800 * 1024) {
          return Response.json({ error: '分片数据无效或超过大小限制' }, { status: 400, headers: corsHeaders() });
        }
        await env.DB.prepare(
          `INSERT INTO book_chunks (vault_id, book_id, chunk_idx, data_b64)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(vault_id, book_id, chunk_idx) DO UPDATE SET data_b64 = excluded.data_b64`,
        ).bind(vaultId, bookId, idx, dataB64).run();
        return Response.json({ ok: true, bookId, idx }, { headers: corsHeaders() });
      }
      if (request.method === 'GET') {
        const row = await env.DB.prepare(
          `SELECT data_b64 FROM book_chunks WHERE vault_id = ? AND book_id = ? AND chunk_idx = ?`,
        ).bind(vaultId, bookId, idx).first();
        if (!row) {
          return Response.json({ error: '分片不存在' }, { status: 404, headers: corsHeaders() });
        }
        return Response.json(
          { ok: true, bookId, idx, dataB64: row.data_b64 },
          { headers: { ...corsHeaders(), 'Cache-Control': 'private, max-age=300' } },
        );
      }
    }

    const commitMatch = /^\/books\/([^/]+)\/commit$/.exec(sub);
    if (commitMatch && request.method === 'POST') {
      const bookId = decodeURIComponent(commitMatch[1]);
      if (!validBookId(bookId)) {
        return Response.json({ error: '无效的书籍 ID' }, { status: 400, headers: corsHeaders() });
      }
      const body = await request.json();
      const chunkCount = Number(body.chunkCount || 0);
      const textHash = String(body.textHash || '').slice(0, 128);
      const encoding = body.encoding === 'utf8' ? 'utf8' : 'gzip';
      const updatedAt = Math.max(1, Number(body.updatedAt) || Date.now());
      const metaJson = JSON.stringify(body.meta || { id: bookId });
      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 500) {
        return Response.json({ error: '分片数量无效' }, { status: 400, headers: corsHeaders() });
      }
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM book_chunks WHERE vault_id = ? AND book_id = ? AND chunk_idx >= ?`)
          .bind(vaultId, bookId, chunkCount),
        env.DB.prepare(
          `INSERT INTO books (vault_id, book_id, meta_json, has_text, text_hash, encoding, chunk_count, updated_at, deleted)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0)
           ON CONFLICT(vault_id, book_id) DO UPDATE SET
             meta_json = excluded.meta_json,
             has_text = 1,
             text_hash = excluded.text_hash,
             encoding = excluded.encoding,
             chunk_count = excluded.chunk_count,
             updated_at = excluded.updated_at,
             deleted = 0`,
        ).bind(vaultId, bookId, metaJson, textHash, encoding, chunkCount, updatedAt),
      ]);
      return Response.json({ ok: true, bookId, chunkCount, updatedAt }, { headers: corsHeaders() });
    }

    return Response.json({ error: 'Not Found' }, { status: 404, headers: corsHeaders() });
  } catch (err) {
    return Response.json(
      { error: err?.message || '云书库读写失败' },
      { status: 500, headers: corsHeaders() },
    );
  }
}

async function synthesizeEdgeTts(text, voice, speed) {
  const connectionId = randomHex(16).toLowerCase();
  const secMsGec = generateSecMsGec();
  const wsUrl =
    `${EDGE_WS_HTTPS_URL}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;

  const upstream = await fetch(wsUrl, {
    headers: {
      Upgrade: 'websocket',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Sec-WebSocket-Version': '13',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `muid=${randomHex(16)};`,
      'User-Agent':
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
        `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    },
  });

  const ws = upstream.webSocket;
  if (!ws) {
    throw new Error(`Edge TTS 握手失败（HTTP ${upstream.status}）`);
  }

  const requestId = randomHex(16).toLowerCase();
  const rate = speedToRate(speed);
  const fullVoice = normalizeVoiceName(voice);
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${escapeXml(fullVoice)}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const audioChunks = [];
  const debugEvents = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`Edge TTS 响应超时 (${debugEvents.join(',')})`));
    }, 25000);

    ws.addEventListener('message', async event => {
      try {
        const data = event.data;
        if (typeof data === 'string') {
          const m = /Path:([^\r\n]+)/.exec(data);
          if (m) debugEvents.push(`t:${m[1].trim()}`);
          if (data.includes('Path:turn.end')) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve();
          }
          return;
        }
        let bytes = null;
        if (data instanceof Uint8Array) bytes = data;
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());

        if (!bytes || bytes.byteLength < 2) return;
        const headerLen = (bytes[0] << 8) | bytes[1];
        if (bytes.byteLength < 2 + headerLen) return;
        const headerText = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
        const body = bytes.slice(2 + headerLen);
        if (headerText.includes('Path:audio') && headerText.includes('Content-Type:audio/mpeg') && body.byteLength > 0) {
          audioChunks.push(body);
        } else {
          debugEvents.push(`b:${body.byteLength}`);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    ws.addEventListener('error', e => {
      clearTimeout(timer);
      reject(new Error(`Edge TTS WebSocket 异常 (${e?.message || 'error'})`));
    });

    ws.addEventListener('close', e => {
      debugEvents.push(`close:${e?.code || 0}:${e?.reason || ''}`);
      clearTimeout(timer);
      resolve();
    });

    ws.accept();
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, -1);
    ws.send(
      `X-Timestamp:${timestamp}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`,
    );
    ws.send(
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${timestamp}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      `${ssml}`,
    );
  });

  const totalLen = audioChunks.reduce((sum, arr) => sum + arr.byteLength, 0);
  if (!totalLen) throw new Error(`Edge TTS 未返回有效音频 [${debugEvents.join('|')}]`);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function synthesizeSegments(segments, defaultVoice, defaultSpeed) {
  const valid = segments
    .map(s => ({
      text: String(s?.text || '').trim(),
      voice: String(s?.voice || defaultVoice || 'zh-CN-YunjianNeural').trim(),
      speed: s?.speed ?? defaultSpeed ?? 1.0,
    }))
    .filter(s => s.text.length > 0);
  if (!valid.length) throw new Error('segments 不能为空');

  const totalChars = valid.reduce((sum, s) => sum + s.text.length, 0);
  if (totalChars > 3500) throw new Error('单次文本最多 3500 字');

  // 限制最多 3 路并发合成，按顺序拼接同规格 48kbps MP3 帧，实现多角色零缝隙连播
  const results = new Array(valid.length);
  let cursor = 0;
  const workerCount = Math.min(3, valid.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < valid.length) {
        const idx = cursor++;
        const seg = valid[idx];
        results[idx] = await synthesizeEdgeTts(seg.text, seg.voice, seg.speed);
      }
    }),
  );

  const totalBytes = results.reduce((sum, arr) => sum + arr.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of results) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json(
        { ok: true, engine: 'cloudflare-edge-tts', version: 'v4', multiRole: true, cloudVault: Boolean(env?.DB) },
        { headers: corsHeaders() },
      );
    }

    if (url.pathname.startsWith('/api/sync/')) {
      return handleSyncRequest(request, url, env);
    }

    // 番茄小说下载：搜索 / 目录 / 正文（每页最多 6 章）
    if (url.pathname === '/api/fanqie' || url.pathname.startsWith('/api/fanqie/')) {
      return handleFanqie(request, env);
    }

    if ((url.pathname === '/v1/audio/speech' || url.pathname === '/api/tts') && request.method === 'POST') {
      if (env?.API_KEY) {
        const auth = request.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.API_KEY}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
        }
      }

      try {
        const body = await request.json();
        const voice = String(body.voice || 'zh-CN-XiaoxiaoNeural').trim();
        const speed = body.speed ?? 1.0;

        let audio;
        if (Array.isArray(body.segments) && body.segments.length > 0) {
          audio = await synthesizeSegments(body.segments, voice, speed);
        } else {
          const text = String(body.input || body.text || '').trim();
          if (!text) {
            return Response.json({ error: 'input 不能为空' }, { status: 400, headers: corsHeaders() });
          }
          if (text.length > 3500) {
            return Response.json({ error: '单次文本最多 3500 字' }, { status: 400, headers: corsHeaders() });
          }
          audio = await synthesizeEdgeTts(text, voice, speed);
        }

        return new Response(audio, {
          headers: {
            ...corsHeaders(),
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      } catch (err) {
        return Response.json(
          { error: err?.message || 'TTS 合成失败' },
          { status: 502, headers: corsHeaders() },
        );
      }
    }

    return Response.json({ error: 'Not Found' }, { status: 404, headers: corsHeaders() });
  },
};
