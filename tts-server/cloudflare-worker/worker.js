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
 */

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
