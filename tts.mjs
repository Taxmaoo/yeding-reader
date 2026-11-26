// 页灯听书引擎：支持在线 AI 语音（Edge-TTS / OpenAI 兼容接口，针对 iPhone Edge/Safari 锁屏连播优化）与浏览器原生朗读兜底。

const SETTINGS_KEY = 'yeding-tts-settings-v1';

export const EDGE_VOICES = Object.freeze([
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声（推荐听书）' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声（推荐都市/玄幻）' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 沉稳播讲（推荐历史/评书）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 灵动女声（推荐言情/轻小说）' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 专业播音' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声' },
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
  apiUrl: '', // 留空时默认尝试同源 ./api/tts；可填自定义 Cloudflare Worker / 自建服务地址
  apiKey: '',
  voice: 'zh-CN-XiaoxiaoNeural',
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
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); // 8-bit unsigned PCM
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  new Uint8Array(buffer, 44).fill(128); // 8-bit PCM 静音中点为 128
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function splitLongParagraph(text, startOffset, maxChars) {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + maxChars);
    if (end < text.length) {
      const slice = text.slice(cursor, end);
      // 尽量在句末标点切分，保持停顿自然
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

// 从指定正文和章节索引中切分朗读块：单块约 300~450 字（约 1.5~2.5 分钟），跨章强制切块。
export function buildReadingChunks(text, chapters, maxChunkChars = 380) {
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

export async function testTtsEndpoint(settings) {
  const endpoint = resolveApiEndpoint(settings.apiUrl);
  const voice = getActiveVoice(settings);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey?.trim()) headers.Authorization = `Bearer ${settings.apiKey.trim()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'tts-1',
        input: '页灯听书连接成功，祝你听书愉快。',
        voice,
        response_format: 'mp3',
        speed: 1.0,
      }),
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
    this.bookTitle = '';
    this.chunks = [];
    this.chunkIndex = -1;
    this.sessionToken = 0;

    // 音频缓存：chunkIndex -> { promise, blobUrl }
    this.cache = new Map();
    this.audio = document.createElement('audio');
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.setAttribute('webkit-playsinline', '');
    this.silentWavUrl = null;
    this.inKeepAlive = false;
    this.switching = false;
    this.lastTime = 0;

    // 定时关闭
    this.sleepMode = 'off'; // 'off' | '15' | '30' | '60' | 'chapter'
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
      // iOS 关键点：每次真正进入 playing 状态都重新绑定 MediaSession，避免锁屏按钮失效或切回 Apple Music
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
        // Web Speech API 需重新播当前块以应用新语速
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

  async start(bookTitle, text, chapters, startOffset) {
    this.bookTitle = bookTitle;
    this.chunks = buildReadingChunks(text, chapters, this.settings.engine === 'web' ? 180 : 380);
    if (!this.chunks.length) {
      this.cb.onToast?.('当前书籍没有可朗读的正文。');
      return;
    }

    this.#clearCache();
    this.active = true;
    const index = findChunkIndexAt(this.chunks, startOffset);
    this.chunkIndex = Math.max(0, index);

    // 关键：在用户点击手势同步栈中先解锁 iOS 的 <audio> 音频会话
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
      // 忽略预热失败，正式播放时会再尝试
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
        // 忽略部分旧浏览器异常
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

    // 若下一段尚未就绪，先切静音保活 WAV，避免 iOS 锁屏期间音频会话超时关闭
    const cached = this.cache.get(index);
    if (!cached?.blobUrl) {
      this.#enterSilentKeepAlive();
    }

    try {
      const blobUrl = await this.#ensureChunkAudio(index);
      if (token !== this.sessionToken || !this.active) return;

      this.inKeepAlive = false;
      this.audio.loop = true; // iOS 锁屏防断流核心：禁止触发原生 ended 关闭会话
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

      // 静默预加载后续 2 段并清理远端旧缓存
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
        ? '未检测到同源 TTS 服务，请点「设置」填写免费语音接口，或切换浏览器原生朗读。'
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
      // 忽略静音保活异常
    }
  }

  #ensureChunkAudio(index) {
    const existing = this.cache.get(index);
    if (existing) return existing.promise;

    const chunk = this.chunks[index];
    const endpoint = resolveApiEndpoint(this.settings.apiUrl);
    const voice = getActiveVoice(this.settings);
    const headers = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey?.trim()) headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;

    const entry = { blobUrl: null, promise: null };
    entry.promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: 'tts-1',
            input: chunk.text,
            voice,
            response_format: 'mp3',
            speed: 1.0,
          }),
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
      // 清空快进/快退，使 iPhone 锁屏与灵动岛直接显示上一句/下一句按钮
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
    } catch {
      // 忽略不支持某项 MediaSession action 的浏览器
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
      // 忽略清理异常
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
      // 忽略释放异常
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
      sleepMode: this.sleepMode,
      sleepLabel: this.getSleepLabel(),
    });
  }
}
