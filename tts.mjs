// 页灯听书引擎：支持免费多角色智能分声（旁白+男女对话自动切换）、iPhone 锁屏防断流连播、听书断点记录与浏览器原生离线兜底。

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
    // 隐私模式或存储满时忽略持久化失败
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

// 多角色自动分声：识别旁白与引号内对话，结合前后文称呼/人称智能分配男女声。
const FEMALE_CUE = /她|姑娘|少女|女孩|女士|小姐|夫人|太太|妻子|老婆|妈妈|母亲|母后|姐姐|妹妹|师姐|师妹|学姐|学妹|阿姨|大嫂|嫂子|大娘|婆婆|公主|皇后|妃|仙子|丫鬟|女秘书|女助理|娇声|娇笑|柔声|轻笑|抿嘴|眨眨眼/;
const MALE_CUE = /他|男子|男人|少年|男孩|先生|书记|县长|市长|局长|主任|老板|总管|老头|大叔|大哥|兄弟|小弟|爷爷|父亲|爸爸|师兄|师弟|少爷|公子|王爷|皇帝|将军|队长|老大|大喝|冷哼|沉声|皱眉|朗声/;

const ROLE_VOICES = Object.freeze({
  narrator: 'zh-CN-YunjianNeural', // 沉稳大叔旁白
  maleA: 'zh-CN-YunxiNeural',      // 青年男声 A
  maleB: 'zh-CN-YunyangNeural',    // 青叔男声 B（双男对话交替）
  femaleA: 'zh-CN-XiaoxiaoNeural', // 温柔女声 A
  femaleB: 'zh-CN-XiaoyiNeural',   // 甜美少女 B
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
    // 仅截取紧邻本句对话的归属上下文（不跨越前一个引号或句号/换行，避免串角色）
    const rawBefore = text.slice(Math.max(0, match.index - 28), match.index);
    const before = rawBefore.split(/[”」』"\n]/).pop() || '';
    const rawAfter = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const after = rawAfter.split(/[“「『"\n]/)[0] || '';

    // 紧接引号前的引导语（如“她轻轻一笑，”或“老周说：”）优先级最高
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

  // 合并相邻同音色片段，减少上游合成次数
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

// 生成 1 秒静音 WAV Blob URL，用于在弱网加载下一段音频时维持 iOS 后台音频会话不被系统挂起。
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

export function buildReadingChunks(text, chapters, maxChunkChars = 360) {
  const chunks = [];
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    const chapter = chapters[chapterIndex];
    const chapterStart = chapter.start;
    const chapterEnd = chapters[chapterIndex + 1]?.start ?? text.length;
    const raw = text.slice(chapterStart, chapterEnd);

    const paragraphs = [];
    let pos = chapterStart;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        const lead = line.length - line.trimStart().length;
        const pStart = pos + lead;
        if (trimmed.length > maxChunkChars) {
          paragraphs.push(...splitLongParagraph(trimmed, pStart, maxChunkChars));
        } else {
          paragraphs.push({ start: pStart, end: pStart + trimmed.length, text: trimmed });
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

    for (const para of paragraphs) {
      if (bucket.length && bucketLen + para.text.length > maxChunkChars) flush();
      bucket.push(para);
      bucketLen += para.text.length + 1;
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

    this.cache = new Map();
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
      if (!this.active || !this.playing || this.switching || this.inKeepAlive) return;
      const { currentTime, duration } = this.audio;
      const nearEnd = Number.isFinite(duration) && duration > 0.6 && (duration - currentTime) <= 0.35;
      const wrapped = this.lastTime > 1.0 && currentTime < this.lastTime - 1.0;
      this.lastTime = currentTime;
      if (nearEnd || wrapped) {
        this.#advanceChunk(1, { auto: true });
      }
    });

    this.audio.addEventListener('ended', () => {
      if (!this.active || !this.playing || this.switching || this.inKeepAlive) return;
      this.#advanceChunk(1, { auto: true });
    });

    this.audio.addEventListener('error', () => {
      if (!this.active || this.switching || this.inKeepAlive) return;
      this.playing = false;
      this.loading = false;
      this.#emitState();
      this.cb.onToast?.('音频播放失败，请检查网络或听书设置。');
    });
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
      this.#clearCache();
      if (this.active && this.chunkIndex >= 0) {
        const shouldResume = this.playing || this.loading;
        this.#stopCurrentPlayback();
        if (shouldResume) this.#playChunk(this.chunkIndex, { fromUser: true });
      }
    } else if (this.active) {
      if (this.settings.engine === 'api') {
        this.#applyPlaybackRate();
      } else if (this.playing) {
        this.#playChunk(this.chunkIndex, { fromUser: true });
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

  async start(bookId, bookTitle, text, chapters, startOffset) {
    this.bookId = bookId;
    this.bookTitle = bookTitle;
    this.chunks = buildReadingChunks(text, chapters, this.settings.engine === 'web' ? 180 : 360);
    if (!this.chunks.length) {
      this.cb.onToast?.('当前书籍没有可朗读的正文。');
      return;
    }

    this.#clearCache();
    this.active = true;
    const index = findChunkIndexAt(this.chunks, startOffset);
    this.chunkIndex = Math.max(0, index);

    if (this.settings.engine === 'api') {
      this.#primeAudioElement();
    }
    this.#requestWakeLock();
    await this.#playChunk(this.chunkIndex, { fromUser: true });
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
      if (this.audio.src && !this.inKeepAlive && this.audio.readyState >= 2) {
        try {
          this.playing = true;
          this.#applyPlaybackRate();
          await this.audio.play();
          this.#syncMediaSession();
          this.#emitState();
          return;
        } catch {
          // 失败时重新加载当前块
        }
      }
      this.#primeAudioElement();
      await this.#playChunk(Math.max(0, this.chunkIndex), { fromUser: true });
    } else {
      await this.#playChunk(Math.max(0, this.chunkIndex), { fromUser: true });
    }
  }

  pause() {
    if (!this.active) return;
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
    this.#syncMediaSession();
    this.#emitState();
  }

  stop() {
    this.sessionToken++;
    this.active = false;
    this.playing = false;
    this.loading = false;
    this.switching = false;
    this.inKeepAlive = false;
    this.setSleepMode('off');
    this.#stopCurrentPlayback();
    this.#clearCache();
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
    const shouldPlay = this.playing || this.loading;
    this.chunkIndex = target;
    if (shouldPlay) {
      await this.#playChunk(target, { fromUser: true });
    } else {
      const chunk = this.chunks[target];
      this.cb.onHighlight?.(chunk);
      this.#emitState();
    }
  }

  async stepChunk(delta) {
    if (!this.active || !this.chunks.length) return;
    await this.#advanceChunk(delta, { auto: false });
  }

  async #advanceChunk(delta, { auto }) {
    const prev = this.chunks[this.chunkIndex];
    const nextIndex = this.chunkIndex + delta;

    if (nextIndex < 0) {
      this.cb.onToast?.('已经是第一段。');
      return;
    }
    if (nextIndex >= this.chunks.length) {
      this.pause();
      this.cb.onBookEnd?.();
      return;
    }

    const next = this.chunks[nextIndex];
    if (auto && this.sleepMode === 'chapter' && prev && next.chapterIndex !== prev.chapterIndex) {
      this.chunkIndex = nextIndex;
      this.setSleepMode('off');
      this.pause();
      this.cb.onChunkChange?.(next);
      this.cb.onToast?.('本章已听完，已按定时暂停。');
      return;
    }

    await this.#playChunk(nextIndex, { fromUser: !auto });
  }

  async #playChunk(index, { fromUser = false } = {}) {
    const chunk = this.chunks[index];
    if (!chunk || !this.active) return;

    const token = ++this.sessionToken;
    this.chunkIndex = index;
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

    const cached = this.cache.get(index);
    if (!cached?.blobUrl) {
      this.#enterSilentKeepAlive();
    }

    try {
      const blobUrl = await this.#ensureChunkAudio(index);
      if (token !== this.sessionToken || !this.active) return;

      this.inKeepAlive = false;
      this.audio.loop = true;
      this.audio.src = blobUrl;
      this.#applyPlaybackRate();
      this.lastTime = 0;

      const playPromise = this.audio.play();
      if (playPromise) await playPromise;

      if (token !== this.sessionToken || !this.active) return;
      this.switching = false;
      this.loading = false;
      this.playing = true;
      this.#syncMediaSession();
      this.#emitState();

      this.#prefetchAhead(index);
      this.#pruneCache(index);
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
        ? '未检测到同源 TTS 服务，请点「设置」检查接口，或切换浏览器原生朗读。'
        : `语音合成失败（${err?.message || '网络异常'}），可在「设置」测试接口或切换原生朗读。`;
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

  #ensureChunkAudio(index) {
    const existing = this.cache.get(index);
    if (existing) return existing.promise;

    const chunk = this.chunks[index];
    const endpoint = resolveApiEndpoint(this.settings.apiUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey?.trim()) headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;

    const entry = { blobUrl: null, promise: null };
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
        const blob = await response.blob();
        if (!blob.size) throw new Error('返回音频为空');
        const blobUrl = URL.createObjectURL(blob);
        entry.blobUrl = blobUrl;
        return blobUrl;
      } catch (err) {
        if (this.cache.get(index) === entry) this.cache.delete(index);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    })();

    this.cache.set(index, entry);
    return entry.promise;
  }

  #prefetchAhead(currentIndex) {
    for (let offset = 1; offset <= 2; offset++) {
      const target = currentIndex + offset;
      if (target < this.chunks.length && !this.cache.has(target)) {
        this.#ensureChunkAudio(target).catch(() => {});
      }
    }
  }

  #pruneCache(currentIndex) {
    for (const [key, entry] of this.cache.entries()) {
      if (key < currentIndex - 1 || key > currentIndex + 3) {
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
        this.cache.delete(key);
      }
    }
  }

  #clearCache() {
    for (const entry of this.cache.values()) {
      if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    }
    this.cache.clear();
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
      this.#advanceChunk(1, { auto: true });
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
