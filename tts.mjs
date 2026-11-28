// 页灯听书引擎：
// - 免费多角色智能分声（旁白+男女对话自动切换）
// - 逐自然段精准切分、高亮与秒级断点续听
// - 后台提前缓存 8 段 + 客户端多段 MP3 无缝拼轨（同轨内段间 0ms 卡顿，兼顾 iPhone 锁屏稳播）

const SETTINGS_KEY = 'yeding-tts-settings-v1';
const LAST_LISTENED_KEY = 'yeding-tts-last-listened-v1';

export const MULTI_ROLE_ID = 'multi-role';

export const EDGE_VOICES = Object.freeze([
  {
    id: MULTI_ROLE_ID,
    name: '升级版 · 多角色',
    desc: '旁白大叔 + 男女对话分声',
    badge: '多角色',
  },
  {
    id: 'zh-CN-YunjianNeural',
    name: '成熟大叔音',
    desc: '沉稳有磁性 · 官场/历史',
    badge: '超推荐',
  },
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: '温柔淑女音',
    desc: '温暖自然 · 全题材百搭',
    badge: '经典',
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    name: '甜美少女音',
    desc: '灵动有感染力 · 言情/轻小说',
    badge: '',
  },
  {
    id: 'zh-CN-YunxiNeural',
    name: '开朗青年音',
    desc: '轻快阳光 · 都市/玄幻',
    badge: '',
  },
  {
    id: 'zh-CN-YunyangNeural',
    name: '清亮青叔音',
    desc: '清晰专业 · 播音质感',
    badge: '',
  },
  {
    id: 'zh-CN-YunxiaNeural',
    name: '活力少年音',
    desc: '清澈少年感',
    badge: '',
  },
  {
    id: 'zh-CN-liaoning-XiaobeiNeural',
    name: '东北爽朗女声',
    desc: '风趣接地气 · 喜剧/日常',
    badge: '方言',
  },
]);

export const SLEEP_OPTIONS = Object.freeze([
  { value: 'off', label: '不定时' },
  { value: '15', label: '15 分钟' },
  { value: '30', label: '30 分钟' },
  { value: '60', label: '60 分钟' },
  { value: 'chapter', label: '听完本章' },
]);

export const DEFAULT_TTS_SETTINGS = Object.freeze({
  engine: 'api', // 'api' | 'web'
  apiUrl: '', // 留空时默认使用同源 ./api/tts
  apiKey: '',
  voice: MULTI_ROLE_ID,
  customVoice: '',
  webVoice: '',
  rate: 1.0,
});

export function loadTtsSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_TTS_SETTINGS };
    return { ...DEFAULT_TTS_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_TTS_SETTINGS };
  }
}

export function saveTtsSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 忽略存储异常
  }
}

export function loadLastListened() {
  try {
    const raw = localStorage.getItem(LAST_LISTENED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLastListened(record) {
  try {
    if (!record) localStorage.removeItem(LAST_LISTENED_KEY);
    else localStorage.setItem(LAST_LISTENED_KEY, JSON.stringify(record));
  } catch {
    // 忽略存储异常
  }
}

// 多角色自动分声：识别旁白与引号内对话，结合紧邻上下文智能分配男女声。
const FEMALE_CUE = /她|姑娘|少女|女孩|女士|小姐|夫人|太太|妻子|老婆|妈妈|母亲|母后|姐姐|妹妹|师姐|师妹|学姐|学妹|阿姨|大嫂|嫂子|大娘|婆婆|公主|皇后|妃|仙子|丫鬟|女秘书|女助理|娇声|娇笑|柔声|轻笑|抿嘴|眨眨眼/;
const MALE_CUE = /他|男子|男人|少年|男孩|先生|书记|县长|市长|局长|主任|老板|总管|老头|大叔|大哥|兄弟|小弟|爷爷|父亲|爸爸|师兄|师弟|少爷|公子|王爷|皇帝|将军|队长|老大|大喝|冷哼|沉声|皱眉|朗声/;

const ROLE_VOICES = Object.freeze({
  narrator: 'zh-CN-YunjianNeural',
  maleA: 'zh-CN-YunxiNeural',
  maleB: 'zh-CN-YunyangNeural',
  femaleA: 'zh-CN-XiaoxiaoNeural',
  femaleB: 'zh-CN-XiaoyiNeural',
});

export function segmentMultiRole(text) {
  const quoteRe = /([“「『"][^”」』"\n]{2,260}[”」』"])/g;
  const rawParts = [];
  let lastIndex = 0;
  let match;
  let maleToggle = 0;
  let femaleToggle = 0;

  while ((match = quoteRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const narr = text.slice(lastIndex, match.index).trim();
      if (narr) rawParts.push({ text: narr, voice: ROLE_VOICES.narrator });
    }
    const quote = match[0].trim();
    const rawBefore = text.slice(Math.max(0, match.index - 28), match.index);
    const before = rawBefore.split(/[”」』"\n]/).pop() || '';
    const rawAfter = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const after = rawAfter.split(/[“「『"\n]/)[0] || '';

    const leadIsCue = /[，,：:]$/.test(before.trim());
    const afterIsOwnTag = after.trim().length > 0 && !/[，,：:]$/.test(after.trim());
    const primary = leadIsCue ? before : afterIsOwnTag ? after : `${before} ${after}`;

    let voice;
    const primaryFemale = FEMALE_CUE.test(primary);
    const primaryMale = MALE_CUE.test(primary);
    if (primaryFemale && !primaryMale) {
      voice = femaleToggle++ % 2 === 0 ? ROLE_VOICES.femaleA : ROLE_VOICES.femaleB;
    } else if (primaryMale && !primaryFemale) {
      voice = maleToggle++ % 2 === 0 ? ROLE_VOICES.maleA : ROLE_VOICES.maleB;
    } else if (FEMALE_CUE.test(`${before} ${after}`) && !MALE_CUE.test(`${before} ${after}`)) {
      voice = femaleToggle++ % 2 === 0 ? ROLE_VOICES.femaleA : ROLE_VOICES.femaleB;
    } else {
      voice = maleToggle++ % 2 === 0 ? ROLE_VOICES.maleA : ROLE_VOICES.maleB;
    }
    rawParts.push({ text: quote, voice });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex).trim();
    if (tail) rawParts.push({ text: tail, voice: ROLE_VOICES.narrator });
  }

  if (!rawParts.length) {
    return [{ text: text.trim(), voice: ROLE_VOICES.narrator }];
  }

  const merged = [];
  for (const part of rawParts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.voice === part.voice && prev.text.length + part.text.length < 360) {
      prev.text = `${prev.text}\n${part.text}`;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

// 精确解析 MP3 帧时长（兼容 Edge-TTS MPEG-2 24kHz 48kbps 及常见 MPEG-1/2 Layer III），
// 并自动跳过拼接块中的 ID3 / Xing / Info 元数据头帧，确保多段拼接无爆音且时间轴精确到毫秒。
const BR_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR_MPEG1 = [44100, 48000, 32000];
const SR_MPEG2 = [22050, 24000, 16000];
const SR_MPEG25 = [11025, 12000, 8000];

function containsTag(u8, start, end, tag) {
  const limit = Math.min(end, u8.length) - tag.length;
  for (let i = start; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < tag.length; j++) {
      if (u8[i + j] !== tag.charCodeAt(j)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export function stripMp3MetadataFrame(u8) {
  let pos = 0;
  // 跳过开头 ID3v2 标签（若有）
  if (u8.length > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
    const id3Len = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
    pos = Math.min(u8.length, 10 + id3Len);
  }
  // 检查首帧是否为 Xing/Info 头帧，若是则剥离，避免拼接时覆盖总时长
  if (pos + 4 <= u8.length && u8[pos] === 0xff && (u8[pos + 1] & 0xe0) === 0xe0) {
    const ver = (u8[pos + 1] >> 3) & 3;
    const brIdx = (u8[pos + 2] >> 4) & 0xf;
    const srIdx = (u8[pos + 2] >> 2) & 3;
    const pad = (u8[pos + 2] >> 1) & 1;
    const br = (ver === 3 ? BR_MPEG1_L3[brIdx] : BR_MPEG2_L3[brIdx]) * 1000;
    const sr = ver === 3 ? SR_MPEG1[srIdx] : ver === 2 ? SR_MPEG2[srIdx] : SR_MPEG25[srIdx];
    if (br && sr) {
      const flen = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
      if (pos + flen <= u8.length && (containsTag(u8, pos, pos + flen, 'Xing') || containsTag(u8, pos, pos + flen, 'Info'))) {
        pos += flen;
      }
    }
  }
  return pos > 0 ? u8.subarray(pos) : u8;
}

export function measureMp3Duration(u8) {
  let pos = 0;
  let totalSec = 0;
  let frames = 0;
  while (pos + 4 <= u8.length) {
    if (u8[pos] === 0xff && (u8[pos + 1] & 0xe0) === 0xe0) {
      const ver = (u8[pos + 1] >> 3) & 3;
      const layer = (u8[pos + 1] >> 1) & 3;
      const brIdx = (u8[pos + 2] >> 4) & 0xf;
      const srIdx = (u8[pos + 2] >> 2) & 3;
      const pad = (u8[pos + 2] >> 1) & 1;
      if (layer !== 1 || ver === 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
        pos++;
        continue;
      }
      const br = (ver === 3 ? BR_MPEG1_L3[brIdx] : BR_MPEG2_L3[brIdx]) * 1000;
      const sr = ver === 3 ? SR_MPEG1[srIdx] : ver === 2 ? SR_MPEG2[srIdx] : SR_MPEG25[srIdx];
      const samples = ver === 3 ? 1152 : 576;
      const flen = Math.floor(((ver === 3 ? 144 : 72) * br) / sr) + pad;
      if (flen <= 0 || pos + flen > u8.length) break;
      totalSec += samples / sr;
      frames++;
      pos += flen;
    } else {
      pos++;
    }
  }
  return frames > 0 ? totalSec : u8.byteLength / 6000;
}

export function stitchMp3Segments(items) {
  // items: [{ chunkIndex, bytes: Uint8Array }]
  const cleaned = [];
  const timeline = [];
  let cursorSec = 0;
  let totalBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const raw = items[i].bytes;
    const part = i === 0 ? raw : stripMp3MetadataFrame(raw);
    const dur = measureMp3Duration(part);
    timeline.push({
      chunkIndex: items[i].chunkIndex,
      startSec: cursorSec,
      endSec: cursorSec + dur,
    });
    cursorSec += dur;
    totalBytes += part.byteLength;
    cleaned.push(part);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of cleaned) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes: merged, timeline, totalSec: cursorSec };
}

function createSilentWavUrl() {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  new Uint8Array(buffer, 44).fill(128);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function splitLongParagraph(text, startOffset, maxChars) {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + maxChars);
    if (end < text.length) {
      const slice = text.slice(cursor, end);
      const punct = Math.max(
        slice.lastIndexOf('。'),
        slice.lastIndexOf('！'),
        slice.lastIndexOf('？'),
        slice.lastIndexOf('；'),
        slice.lastIndexOf('”'),
        slice.lastIndexOf('.'),
        slice.lastIndexOf('!'),
        slice.lastIndexOf('?'),
      );
      if (punct >= Math.floor(maxChars * 0.45)) {
        end = cursor + punct + 1;
      } else {
        const comma = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf('、'), slice.lastIndexOf(','));
        if (comma >= Math.floor(maxChars * 0.55)) end = cursor + comma + 1;
      }
    }
    const piece = text.slice(cursor, end);
    const trimmed = piece.trim();
    if (trimmed) {
      const lead = piece.length - piece.trimStart().length;
      parts.push({
        start: startOffset + cursor + lead,
        end: startOffset + cursor + lead + trimmed.length,
        text: trimmed,
      });
    }
    cursor = end;
  }
  return parts;
}

export function buildReadingChunks(text, chapters, maxChunkChars = 140, minChunkChars = 28) {
  const chunks = [];
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    const chapter = chapters[chapterIndex];
    const chapterStart = chapter.start;
    const chapterEnd = chapters[chapterIndex + 1]?.start ?? text.length;
    const raw = text.slice(chapterStart, chapterEnd);

    const units = [];
    let pos = chapterStart;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        const lead = line.length - line.trimStart().length;
        const pStart = pos + lead;
        if (trimmed.length > maxChunkChars) {
          units.push(...splitLongParagraph(trimmed, pStart, maxChunkChars));
        } else {
          units.push({ start: pStart, end: pStart + trimmed.length, text: trimmed });
        }
      }
      pos += line.length + 1;
    }

    let bucket = [];
    let bucketLen = 0;
    const flush = () => {
      if (!bucket.length) return;
      chunks.push({
        index: chunks.length,
        chapterIndex,
        chapterTitle: chapter.title,
        start: bucket[0].start,
        end: bucket[bucket.length - 1].end,
        text: bucket.map(item => item.text).join('\n'),
      });
      bucket = [];
      bucketLen = 0;
    };

    for (const unit of units) {
      if (bucket.length && (bucketLen >= minChunkChars || bucketLen + unit.text.length > maxChunkChars)) {
        flush();
      }
      bucket.push(unit);
      bucketLen += unit.text.length + 1;
      if (bucketLen >= minChunkChars) flush();
    }
    flush();
  }
  return chunks;
}

export function findChunkIndexAt(chunks, offset) {
  if (!chunks.length) return -1;
  let low = 0;
  let high = chunks.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (chunks[mid].end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function resolveApiEndpoint(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return new URL('./api/tts', location.href).href;
  if (/\/(v1\/audio\/speech|api\/tts|tts)\/?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, '')}/v1/audio/speech`;
}

export function getActiveVoice(settings) {
  return (settings.customVoice || '').trim() || settings.voice || DEFAULT_TTS_SETTINGS.voice;
}

export function getVoiceDisplayName(voiceId) {
  const found = EDGE_VOICES.find(v => v.id === voiceId);
  return found ? found.name : voiceId;
}

function buildTtsRequestBody(text, settings) {
  const voice = getActiveVoice(settings);
  if (voice === MULTI_ROLE_ID) {
    const segments = segmentMultiRole(text);
    if (segments.length > 1) {
      return {
        model: 'tts-1',
        segments,
        voice: ROLE_VOICES.narrator,
        response_format: 'mp3',
        speed: 1.0,
      };
    }
    return {
      model: 'tts-1',
      input: segments[0].text,
      voice: segments[0].voice,
      response_format: 'mp3',
      speed: 1.0,
    };
  }
  return {
    model: 'tts-1',
    input: text,
    voice,
    response_format: 'mp3',
    speed: 1.0,
  };
}

export async function testTtsEndpoint(settings) {
  const endpoint = resolveApiEndpoint(settings.apiUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey?.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  const sampleText = getActiveVoice(settings) === MULTI_ROLE_ID
    ? '夜色渐深，老周推开了门。“今天有你的新信。”她笑着接过信纸。'
    : '页灯听书连接成功，祝你听书愉快。';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(buildTtsRequestBody(sampleText, settings)),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('返回音频为空');
    return { blob, endpoint };
  } finally {
    clearTimeout(timer);
  }
}

export class TtsController {
  constructor(callbacks) {
    this.cb = callbacks;
    this.settings = loadTtsSettings();
    this.active = false;
    this.playing = false;
    this.loading = false;
    this.bookId = '';
    this.bookTitle = '';
    this.chunks = [];
    this.chunkIndex = -1;
    this.sessionToken = 0;

    // 原始段级 MP3 字节缓存：chunkIndex -> { bytes, promise }（提前缓存 8 段，切换零等待）
    this.rawCache = new Map();
    this.prefetchQueue = [];
    this.activePrefetches = 0;

    // 当前正在播放的「无缝拼轨」信息：{ startIndex, endIndex, timeline, totalSec, blobUrl }
    this.track = null;
    this.nextTrackPromise = null;
    this.nextTrackStartIndex = -1;
    this.nextTrackReady = null;

    this.audio = document.createElement('audio');
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.setAttribute('webkit-playsinline', '');
    this.silentWavUrl = null;
    this.inKeepAlive = false;
    this.switching = false;
    this.lastTime = 0;

    this.sleepMode = 'off';
    this.sleepUntil = 0;
    this.sleepInterval = null;
    this.wakeLock = null;

    this.#bindAudioEvents();
  }

  #bindAudioEvents() {
    this.audio.addEventListener('playing', () => {
      if (!this.active || this.inKeepAlive) return;
      this.playing = true;
      this.loading = false;
      this.#applyPlaybackRate();
      this.#syncMediaSession();
      this.#emitState();
    });

    this.audio.addEventListener('pause', () => {
      if (!this.active || this.switching || this.inKeepAlive) return;
      this.playing = false;
      this.#syncMediaSession();
      this.#emitState();
    });

    this.audio.addEventListener('timeupdate', () => {
      if (!this.active || !this.playing || this.switching || this.inKeepAlive || !this.track) return;
      const { currentTime, duration } = this.audio;

      // 1) 在同一条拼轨内根据精确时间轴实时推进段落高亮与进度（0ms 音频中断！）
      const entry = this.#timelineEntryAt(currentTime);
      if (entry && entry.chunkIndex !== this.chunkIndex) {
        this.chunkIndex = entry.chunkIndex;
        const chunk = this.chunks[this.chunkIndex];
        if (chunk) {
          this.cb.onChunkChange?.(chunk);
          this.cb.onHighlight?.(chunk);
          this.#syncMediaSession();
          this.#emitState();
        }
        // 持续补充提前缓存池并提前拼好下一轨
        this.#schedulePrefetch(this.chunkIndex);
      }

      // 2) 接近本轨末尾或锁屏回绕时无缝切换至已拼好的下一轨（按倍速自适应提前余量，避免 1.5x/2.0x 回跳重读）
      const rate = Math.max(0.5, Number(this.audio.playbackRate) || Number(this.settings.rate) || 1.0);
      const effectiveDur = Number.isFinite(duration) && duration > 0 ? duration : this.track.totalSec;
      const endMargin = Math.min(0.7, Math.max(0.22, 0.28 * rate));
      const nearEnd = effectiveDur > 0.4 && (effectiveDur - currentTime) <= endMargin;
      const wrapped = this.lastTime > Math.max(0.45, effectiveDur * 0.5) && currentTime < this.lastTime - 0.3;
      this.lastTime = currentTime;
      if (nearEnd || wrapped) {
        this.#advanceToNextTrack({ auto: true });
      }
    });

    this.audio.addEventListener('ended', () => {
      if (!this.active || !this.playing || this.switching || this.inKeepAlive) return;
      this.#advanceToNextTrack({ auto: true });
    });

    this.audio.addEventListener('error', () => {
      if (!this.active || this.switching || this.inKeepAlive) return;
      this.playing = false;
      this.loading = false;
      this.#emitState();
      this.cb.onToast?.('音频播放失败，请检查网络或听书设置。');
    });
  }

  #timelineEntryAt(sec) {
    const tl = this.track?.timeline;
    if (!tl?.length) return null;
    for (let i = tl.length - 1; i >= 0; i--) {
      if (sec >= tl[i].startSec - 0.05) return tl[i];
    }
    return tl[0];
  }

  #ensureSilentWav() {
    if (!this.silentWavUrl) this.silentWavUrl = createSilentWavUrl();
    return this.silentWavUrl;
  }

  #applyPlaybackRate() {
    const rate = Number(this.settings.rate) || 1.0;
    this.audio.playbackRate = rate;
    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
    if ('webkitPreservesPitch' in this.audio) this.audio.webkitPreservesPitch = true;
  }

  updateSettings(patch) {
    const prevEngine = this.settings.engine;
    const prevVoice = getActiveVoice(this.settings);
    const prevUrl = this.settings.apiUrl;
    const prevKey = this.settings.apiKey;
    const prevWebVoice = this.settings.webVoice;

    this.settings = { ...this.settings, ...patch };
    saveTtsSettings(this.settings);

    const sourceChanged =
      prevEngine !== this.settings.engine ||
      prevVoice !== getActiveVoice(this.settings) ||
      prevUrl !== this.settings.apiUrl ||
      prevKey !== this.settings.apiKey ||
      prevWebVoice !== this.settings.webVoice;

    if (sourceChanged) {
      this.#clearAllCaches();
      if (this.active && this.chunkIndex >= 0) {
        const shouldResume = this.playing || this.loading;
        if (shouldResume && this.settings.engine === 'api') {
          // 保持静音保活而不是 audio.load() 释放会话，防止 iPhone 切音色触发 NotAllowedError
          this.#enterSilentKeepAlive();
          this.#playFromChunk(this.chunkIndex, { fromUser: true, fastStart: true });
        } else {
          this.#stopCurrentPlayback();
          if (shouldResume) this.#playFromChunk(this.chunkIndex, { fromUser: true, fastStart: true });
        }
      }
    } else if (this.active) {
      if (this.settings.engine === 'api') {
        this.#applyPlaybackRate();
      } else if (this.playing) {
        this.#playFromChunk(this.chunkIndex, { fromUser: true, fastStart: true });
      }
    }
    this.#emitState();
  }

  setSleepMode(mode) {
    this.sleepMode = mode;
    clearInterval(this.sleepInterval);
    this.sleepInterval = null;
    this.sleepUntil = 0;

    if (mode === '15' || mode === '30' || mode === '60') {
      this.sleepUntil = Date.now() + Number(mode) * 60 * 1000;
      this.sleepInterval = setInterval(() => {
        if (!this.active) return this.setSleepMode('off');
        if (Date.now() >= this.sleepUntil) {
          this.setSleepMode('off');
          this.pause();
          this.cb.onToast?.('定时关闭已到，已暂停听书。');
          return;
        }
        this.#emitState();
      }, 1000);
    }
    this.#emitState();
  }

  getSleepLabel() {
    if (this.sleepMode === 'chapter') return '本章后停';
    if (this.sleepUntil > Date.now()) {
      const remain = Math.max(0, Math.ceil((this.sleepUntil - Date.now()) / 1000));
      const mm = String(Math.floor(remain / 60)).padStart(2, '0');
      const ss = String(remain % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    }
    return '定时';
  }

  getCurrentChunk() {
    return this.chunks[this.chunkIndex] ?? null;
  }

  // 返回当前段落内部的相对秒数（即使处于多段拼轨中也能精准扣除前面段时长）
  getCurrentAudioTime() {
    if (this.settings.engine !== 'api' || this.inKeepAlive || !this.track) return 0;
    const t = this.audio.currentTime;
    if (!Number.isFinite(t)) return 0;
    const entry = this.track.timeline.find(item => item.chunkIndex === this.chunkIndex);
    if (!entry) return 0;
    const rel = t - entry.startSec;
    const segDur = entry.endSec - entry.startSec;
    if (rel < 0.5 || segDur - rel < 1.0) return 0;
    return Math.round(rel * 10) / 10;
  }

  async start(bookId, bookTitle, text, chapters, startOffset, resumeAudioTime = 0) {
    this.bookId = bookId;
    this.bookTitle = bookTitle;
    this.chunks = buildReadingChunks(
      text,
      chapters,
      this.settings.engine === 'web' ? 120 : 140,
      this.settings.engine === 'web' ? 16 : 28,
    );
    if (!this.chunks.length) {
      this.cb.onToast?.('当前书籍没有可朗读的正文。');
      return;
    }

    this.#clearAllCaches();
    this.active = true;
    const index = findChunkIndexAt(this.chunks, startOffset);
    this.chunkIndex = Math.max(0, index);

    if (this.settings.engine === 'api') {
      this.#primeAudioElement();
    }
    this.#requestWakeLock();
    // 首次起播用 fastStart=true（先秒开当前 1 段，同时后台立刻预缓存并拼好后续 6 段大轨）
    await this.#playFromChunk(this.chunkIndex, { fromUser: true, resumeTime: resumeAudioTime, fastStart: true });
  }

  #primeAudioElement() {
    try {
      this.inKeepAlive = true;
      this.audio.loop = true;
      this.audio.src = this.#ensureSilentWav();
      const promise = this.audio.play();
      if (promise?.catch) promise.catch(() => {});
    } catch {
      // 忽略预热失败
    }
  }

  async togglePlay() {
    if (!this.active) return;
    if (this.playing || this.loading) {
      this.pause();
      return;
    }
    if (this.settings.engine === 'api') {
      if (this.audio.src && !this.inKeepAlive && !this.audio.error && this.audio.readyState >= 2) {
        try {
          this.playing = true;
          this.#applyPlaybackRate();
          await this.audio.play();
          this.#syncMediaSession();
          this.#emitState();
          return;
        } catch {
          // 失败时重播当前段
        }
      }
      this.#primeAudioElement();
      await this.#playFromChunk(Math.max(0, this.chunkIndex), { fromUser: true, fastStart: true });
    } else {
      await this.#playFromChunk(Math.max(0, this.chunkIndex), { fromUser: true, fastStart: true });
    }
  }

  pause() {
    if (!this.active) return;
    const chunk = this.getCurrentChunk();
    const audioTime = this.getCurrentAudioTime();
    this.sessionToken++;
    this.playing = false;
    this.loading = false;
    this.switching = false;
    this.inKeepAlive = false;
    if (this.settings.engine === 'api') {
      this.audio.pause();
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (chunk) this.cb.onPauseProgress?.(chunk, audioTime);
    this.#syncMediaSession();
    this.#emitState();
  }

  stop() {
    const chunk = this.active ? this.getCurrentChunk() : null;
    const audioTime = this.active ? this.getCurrentAudioTime() : 0;
    if (chunk) this.cb.onPauseProgress?.(chunk, audioTime);
    this.sessionToken++;
    this.active = false;
    this.playing = false;
    this.loading = false;
    this.switching = false;
    this.inKeepAlive = false;
    this.setSleepMode('off');
    this.#stopCurrentPlayback();
    this.#clearAllCaches();
    this.#releaseWakeLock();
    this.chunks = [];
    this.chunkIndex = -1;
    this.#clearMediaSession();
    this.cb.onHighlight?.(null);
    this.#emitState();
  }

  #stopCurrentPlayback() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // 忽略异常
      }
    }
  }

  async seekToOffset(offset) {
    if (!this.active || !this.chunks.length) return;
    const target = findChunkIndexAt(this.chunks, offset);
    if (target < 0) return;
    if (target === this.chunkIndex && (this.playing || this.loading)) return;
    await this.#jumpToChunk(target, this.playing || this.loading);
  }

  async stepChunk(delta) {
    if (!this.active || !this.chunks.length) return;
    const target = this.chunkIndex + delta;
    if (target < 0) {
      this.cb.onToast?.('已经是第一段。');
      return;
    }
    if (target >= this.chunks.length) {
      this.pause();
      this.cb.onBookEnd?.();
      return;
    }
    await this.#jumpToChunk(target, true);
  }

  async #jumpToChunk(targetIndex, shouldPlay) {
    // 若目标段就在当前已加载的拼轨内，直接秒跳 currentTime，零等待零重下！
    if (this.settings.engine === 'api' && this.track && !this.inKeepAlive && !this.switching) {
      const entry = this.track.timeline.find(item => item.chunkIndex === targetIndex);
      if (entry && this.audio.readyState >= 1) {
        this.chunkIndex = targetIndex;
        this.audio.currentTime = entry.startSec;
        this.lastTime = entry.startSec;
        const chunk = this.chunks[targetIndex];
        this.cb.onChunkChange?.(chunk);
        this.cb.onHighlight?.(chunk);
        if (shouldPlay && this.audio.paused) {
          this.#applyPlaybackRate();
          await this.audio.play().catch(() => {});
        }
        this.#syncMediaSession();
        this.#emitState();
        this.#schedulePrefetch(targetIndex);
        return;
      }
    }

    this.chunkIndex = targetIndex;
    if (shouldPlay) {
      await this.#playFromChunk(targetIndex, { fromUser: true, fastStart: true });
    } else {
      const chunk = this.chunks[targetIndex];
      this.cb.onHighlight?.(chunk);
      this.#emitState();
    }
  }

  async #advanceToNextTrack({ auto }) {
    const prevEndIndex = this.track ? this.track.endIndex : this.chunkIndex;
    const prevChunk = this.chunks[prevEndIndex];
    const nextStart = prevEndIndex + 1;

    if (nextStart >= this.chunks.length) {
      this.pause();
      this.cb.onBookEnd?.();
      return;
    }

    const nextChunk = this.chunks[nextStart];
    if (auto && this.sleepMode === 'chapter' && prevChunk && nextChunk.chapterIndex !== prevChunk.chapterIndex) {
      this.chunkIndex = nextStart;
      this.setSleepMode('off');
      this.pause();
      this.cb.onChunkChange?.(nextChunk);
      this.cb.onToast?.('本章已听完，已按定时暂停。');
      return;
    }

    await this.#playFromChunk(nextStart, { fromUser: !auto, fastStart: false });
  }

  // 计算从 startIndex 开始可以拼进同一条连续 MP3 轨的段落区间（不跨章，最多 6 段 ≈ 1.5~2.5 分钟）
  #computeTrackSpan(startIndex, fastStart) {
    if (fastStart) {
      // 若后续已有提前缓存好的段，一并拼上；否则先秒播当前 1 段实现 0.4s 起播
      let end = startIndex;
      const chap = this.chunks[startIndex].chapterIndex;
      while (
        end + 1 < this.chunks.length &&
        end - startIndex + 1 < 6 &&
        this.chunks[end + 1].chapterIndex === chap &&
        this.rawCache.get(end + 1)?.bytes
      ) {
        end++;
      }
      return { start: startIndex, end };
    }

    const chap = this.chunks[startIndex].chapterIndex;
    let end = startIndex;
    let charBudget = this.chunks[startIndex].text.length;
    while (
      end + 1 < this.chunks.length &&
      end - startIndex + 1 < 6 &&
      charBudget + this.chunks[end + 1].text.length <= 750 &&
      this.chunks[end + 1].chapterIndex === chap
    ) {
      end++;
      charBudget += this.chunks[end].text.length;
    }
    return { start: startIndex, end };
  }

  async #buildTrack(startIndex, endIndex) {
    const items = [];
    for (let i = startIndex; i <= endIndex; i++) {
      const bytes = await this.#ensureChunkBytes(i);
      items.push({ chunkIndex: i, bytes });
    }
    const { bytes, timeline, totalSec } = stitchMp3Segments(items);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    return { startIndex, endIndex, timeline, totalSec, blobUrl };
  }

  #prepareNextTrack(afterEndIndex) {
    const nextStart = afterEndIndex + 1;
    if (nextStart >= this.chunks.length) return;
    if (this.nextTrackStartIndex === nextStart && (this.nextTrackReady || this.nextTrackPromise)) return;

    this.#revokeNextTrack();
    this.nextTrackStartIndex = nextStart;
    const { start, end } = this.#computeTrackSpan(nextStart, false);
    this.nextTrackPromise = this.#buildTrack(start, end)
      .then(built => {
        if (this.nextTrackStartIndex === nextStart && this.active) {
          this.nextTrackReady = built;
          return built;
        }
        URL.revokeObjectURL(built.blobUrl);
        return null;
      })
      .catch(() => {
        if (this.nextTrackStartIndex === nextStart) {
          this.nextTrackStartIndex = -1;
          this.nextTrackPromise = null;
        }
        return null;
      });
  }

  async #playFromChunk(startIndex, { fromUser = false, resumeTime = 0, fastStart = false } = {}) {
    const chunk = this.chunks[startIndex];
    if (!chunk || !this.active) return;

    const token = ++this.sessionToken;
    this.chunkIndex = startIndex;
    this.lastTime = 0;
    this.cb.onChunkChange?.(chunk);
    this.cb.onHighlight?.(chunk);

    if (this.settings.engine === 'web') {
      this.#playWithWebSpeech(chunk, token);
      return;
    }

    this.switching = true;
    this.loading = true;
    this.#emitState();

    // 立刻启动后台 8 段预缓存，绝不干等
    this.#schedulePrefetch(startIndex);

    // 优先直接拿已经提前拼好的下一轨（0ms 网络等待！）
    let builtTrack = null;
    if (this.nextTrackStartIndex === startIndex && this.nextTrackReady) {
      builtTrack = this.nextTrackReady;
      this.nextTrackReady = null;
      this.nextTrackPromise = null;
      this.nextTrackStartIndex = -1;
    } else if (this.nextTrackStartIndex === startIndex && this.nextTrackPromise) {
      this.#enterSilentKeepAlive();
      builtTrack = await this.nextTrackPromise;
      this.nextTrackReady = null;
      this.nextTrackPromise = null;
      this.nextTrackStartIndex = -1;
    }

    try {
      if (!builtTrack) {
        const { start, end } = this.#computeTrackSpan(startIndex, fastStart);
        // 若所需段不全在缓存中，切静音保活防 iOS 锁屏断流
        let allReady = true;
        for (let i = start; i <= end; i++) {
          if (!this.rawCache.get(i)?.bytes) { allReady = false; break; }
        }
        if (!allReady) this.#enterSilentKeepAlive();
        builtTrack = await this.#buildTrack(start, end);
      }

      if (token !== this.sessionToken || !this.active) {
        if (builtTrack?.blobUrl) URL.revokeObjectURL(builtTrack.blobUrl);
        return;
      }

      const prevUrl = this.track?.blobUrl;
      this.track = builtTrack;
      this.inKeepAlive = false;
      this.audio.loop = true;
      this.audio.src = builtTrack.blobUrl;
      this.#applyPlaybackRate();
      this.lastTime = 0;
      if (prevUrl && prevUrl !== builtTrack.blobUrl) {
        setTimeout(() => URL.revokeObjectURL(prevUrl), 5000);
      }

      if (resumeTime > 0.5) {
        const applySeek = () => {
          if (Number.isFinite(this.audio.duration) && resumeTime < this.audio.duration - 1.0) {
            this.audio.currentTime = resumeTime;
            this.lastTime = resumeTime;
          }
        };
        if (this.audio.readyState >= 1) applySeek();
        else this.audio.addEventListener('loadedmetadata', applySeek, { once: true });
      }

      const playPromise = this.audio.play();
      if (playPromise) await playPromise;

      if (token !== this.sessionToken || !this.active) return;
      this.switching = false;
      this.loading = false;
      this.playing = true;
      this.#syncMediaSession();
      this.#emitState();

      // 立刻开始提前缓存并预拼下一整条 6 段连续音轨
      this.#schedulePrefetch(builtTrack.endIndex);
      this.#prepareNextTrack(builtTrack.endIndex);
      this.#pruneRawCache(startIndex);
    } catch (err) {
      if (token !== this.sessionToken || !this.active) return;
      this.switching = false;
      this.loading = false;
      this.playing = false;
      this.inKeepAlive = false;
      this.audio.pause();
      this.#emitState();

      if (err?.name === 'NotAllowedError') {
        this.cb.onToast?.('浏览器拦截了自动播放，请轻点播放键继续。');
        return;
      }
      const hint = !this.settings.apiUrl?.trim()
        ? '未检测到同源 TTS 服务，请点「音色」检查接口，或切换离线原生朗读。'
        : `语音合成失败（${err?.message || '网络异常'}），可在「音色」测试接口或切换离线朗读。`;
      this.cb.onToast?.(hint);
      if (fromUser) this.cb.onNeedConfig?.();
    }
  }

  #enterSilentKeepAlive() {
    try {
      this.inKeepAlive = true;
      this.audio.loop = true;
      this.audio.src = this.#ensureSilentWav();
      const promise = this.audio.play();
      if (promise?.catch) promise.catch(() => {});
    } catch {
      // 忽略异常
    }
  }

  #ensureChunkBytes(index) {
    const existing = this.rawCache.get(index);
    if (existing) return existing.promise;

    const chunk = this.chunks[index];
    const endpoint = resolveApiEndpoint(this.settings.apiUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey?.trim()) headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;

    const entry = { bytes: null, promise: null };
    entry.promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(buildTtsRequestBody(chunk.text, this.settings)),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}${detail ? ` ${detail.slice(0, 60)}` : ''}`);
        }
        const buf = await response.arrayBuffer();
        if (!buf.byteLength) throw new Error('返回音频为空');
        const bytes = new Uint8Array(buf);
        entry.bytes = bytes;
        return bytes;
      } catch (err) {
        if (this.rawCache.get(index) === entry) this.rawCache.delete(index);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();

    this.rawCache.set(index, entry);
    return entry.promise;
  }

  // 受控并发（最多 2 路）持续提前缓存后面 8 个自然段，不抢占当前段带宽
  #schedulePrefetch(anchorIndex) {
    if (this.settings.engine !== 'api' || !this.active) return;
    for (let offset = 1; offset <= 8; offset++) {
      const target = anchorIndex + offset;
      if (target < this.chunks.length && !this.rawCache.has(target) && !this.prefetchQueue.includes(target)) {
        this.prefetchQueue.push(target);
      }
    }
    this.#drainPrefetchQueue();
  }

  #drainPrefetchQueue() {
    while (this.active && this.activePrefetches < 2 && this.prefetchQueue.length > 0) {
      const target = this.prefetchQueue.shift();
      if (this.rawCache.has(target) || target < this.chunkIndex) continue;
      this.activePrefetches++;
      this.#ensureChunkBytes(target)
        .catch(() => {})
        .finally(() => {
          this.activePrefetches--;
          this.#drainPrefetchQueue();
        });
    }
  }

  #pruneRawCache(currentIndex) {
    for (const key of this.rawCache.keys()) {
      if (key < currentIndex - 3 || key > currentIndex + 16) {
        this.rawCache.delete(key);
      }
    }
  }

  #revokeNextTrack() {
    if (this.nextTrackReady?.blobUrl) URL.revokeObjectURL(this.nextTrackReady.blobUrl);
    this.nextTrackReady = null;
    this.nextTrackPromise = null;
    this.nextTrackStartIndex = -1;
  }

  #clearAllCaches() {
    this.prefetchQueue = [];
    this.rawCache.clear();
    if (this.track?.blobUrl) URL.revokeObjectURL(this.track.blobUrl);
    this.track = null;
    this.#revokeNextTrack();
  }

  #playWithWebSpeech(chunk, token) {
    if (!('speechSynthesis' in window)) {
      this.playing = false;
      this.loading = false;
      this.#emitState();
      this.cb.onToast?.('当前浏览器不支持原生语音朗读。');
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.lang = 'zh-CN';
    utterance.rate = Number(this.settings.rate) || 1.0;

    const voices = window.speechSynthesis.getVoices?.() || [];
    const chosen = this.settings.webVoice
      ? voices.find(v => v.voiceURI === this.settings.webVoice)
      : voices.find(v => /^zh/i.test(v.lang) && /Ting|Xiaoxiao|Siri|Enhanced|Premium/i.test(v.name))
        || voices.find(v => /^zh/i.test(v.lang));
    if (chosen) utterance.voice = chosen;

    utterance.onstart = () => {
      if (token !== this.sessionToken || !this.active) return;
      this.loading = false;
      this.playing = true;
      this.#emitState();
    };
    utterance.onend = () => {
      if (token !== this.sessionToken || !this.active || !this.playing) return;
      const next = this.chunkIndex + 1;
      if (next >= this.chunks.length) {
        this.pause();
        this.cb.onBookEnd?.();
        return;
      }
      if (this.sleepMode === 'chapter' && this.chunks[next].chapterIndex !== chunk.chapterIndex) {
        this.chunkIndex = next;
        this.setSleepMode('off');
        this.pause();
        this.cb.onChunkChange?.(this.chunks[next]);
        this.cb.onToast?.('本章已听完，已按定时暂停。');
        return;
      }
      this.#playFromChunk(next, { fromUser: false });
    };
    utterance.onerror = event => {
      if (token !== this.sessionToken || !this.active) return;
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      this.playing = false;
      this.loading = false;
      this.#emitState();
      this.cb.onToast?.('浏览器朗读中断，请重试。');
    };

    this.loading = false;
    this.playing = true;
    this.#emitState();
    window.speechSynthesis.speak(utterance);
  }

  #syncMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const chunk = this.getCurrentChunk();
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chunk?.chapterTitle || this.bookTitle || '页灯听书',
        artist: this.bookTitle || '页灯阅读器',
        album: '页灯 · 听书',
        artwork: [
          { src: new URL('./icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
          { src: new URL('./icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => { this.togglePlay(); });
      navigator.mediaSession.setActionHandler('pause', () => { this.pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', () => { this.stepChunk(-1); });
      navigator.mediaSession.setActionHandler('nexttrack', () => { this.stepChunk(1); });
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    } catch {
      // 忽略异常
    }
  }

  #clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
      for (const action of ['play', 'pause', 'previoustrack', 'nexttrack']) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    } catch {
      // 忽略异常
    }
  }

  async #requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  async #releaseWakeLock() {
    try {
      await this.wakeLock?.release();
    } catch {
      // 忽略异常
    }
    this.wakeLock = null;
  }

  #emitState() {
    this.cb.onStateChange?.({
      active: this.active,
      playing: this.playing,
      loading: this.loading,
      chunk: this.getCurrentChunk(),
      chunkIndex: this.chunkIndex,
      totalChunks: this.chunks.length,
      rate: Number(this.settings.rate) || 1.0,
      engine: this.settings.engine,
      voice: getActiveVoice(this.settings),
      voiceName: getVoiceDisplayName(getActiveVoice(this.settings)),
      sleepMode: this.sleepMode,
      sleepLabel: this.getSleepLabel(),
    });
  }
}
