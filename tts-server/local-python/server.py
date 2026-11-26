#!/usr/bin/env python3
"""
页灯阅读器 · 本地 / 局域网 / NAS / Docker 一体化免费 Edge-TTS 服务端。

特点：
- 仅依赖 edge-tts（自带 aiohttp），安装极快、完全免费、国内直连微软 Edge 语音无需代理。
- 同时托管上级目录的页灯静态站点，实现同源部署（打开 http://电脑局域网IP:8787 即可直接在 iPhone Edge 听书，免配接口地址）。
- 同时暴露标准 OpenAI 兼容接口 POST /v1/audio/speech 和 POST /api/tts，支持跨站调用与可选 API Key 鉴权。
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import socket
from collections import OrderedDict
from pathlib import Path

import edge_tts
from aiohttp import web

ROOT_DIR = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("PORT", "8787"))
HOST = os.environ.get("HOST", "0.0.0.0")
API_KEY = os.environ.get("TTS_API_KEY", "").strip()
DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "zh-CN-XiaoxiaoNeural")
CACHE_LIMIT = int(os.environ.get("TTS_CACHE_LIMIT", "64"))

# 内存 LRU 缓存，避免重复合成同一段文本
AUDIO_CACHE: OrderedDict[str, bytes] = OrderedDict()

MIME_OVERRIDES = {
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
}


def cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
    }


def check_auth(request: web.Request) -> bool:
    if not API_KEY:
        return True
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {API_KEY}"


def speed_to_rate(speed: float) -> str:
    clamped = max(0.5, min(2.0, float(speed)))
    pct = round((clamped - 1.0) * 100)
    return f"+{pct}%" if pct >= 0 else f"{pct}%"


async def synthesize_mp3(text: str, voice: str, speed: float) -> bytes:
    rate = speed_to_rate(speed)
    cache_key = hashlib.sha256(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()
    cached = AUDIO_CACHE.get(cache_key)
    if cached is not None:
        AUDIO_CACHE.move_to_end(cache_key)
        return cached

    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate)
    chunks: list[bytes] = []
    async for msg in communicate.stream():
        if msg["type"] == "audio":
            chunks.append(msg["data"])

    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("Edge-TTS 未返回音频数据")

    AUDIO_CACHE[cache_key] = audio
    if len(AUDIO_CACHE) > CACHE_LIMIT:
        AUDIO_CACHE.popitem(last=False)
    return audio


async def handle_options(_request: web.Request) -> web.Response:
    return web.Response(status=204, headers=cors_headers())


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "engine": "edge-tts"}, headers=cors_headers())


async def handle_voices(request: web.Request) -> web.Response:
    if not check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401, headers=cors_headers())
    voices = await edge_tts.list_voices()
    zh = [
        {"id": v["ShortName"], "gender": v["Gender"], "locale": v["Locale"]}
        for v in voices
        if v.get("Locale", "").startswith("zh-")
    ]
    return web.json_response({"voices": zh}, headers=cors_headers())


async def handle_tts(request: web.Request) -> web.Response:
    if not check_auth(request):
        return web.json_response({"error": "Unauthorized"}, status=401, headers=cors_headers())

    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "请求体必须为 JSON"}, status=400, headers=cors_headers())

    text = str(payload.get("input") or payload.get("text") or "").strip()
    voice = str(payload.get("voice") or DEFAULT_VOICE).strip()
    speed = payload.get("speed", 1.0)

    if not text:
        return web.json_response({"error": "input 不能为空"}, status=400, headers=cors_headers())
    if len(text) > 3000:
        return web.json_response({"error": "单次文本过长（最多 3000 字）"}, status=400, headers=cors_headers())

    try:
        audio = await synthesize_mp3(text, voice, float(speed))
    except Exception as exc:
        return web.json_response({"error": f"语音合成失败: {exc}"}, status=502, headers=cors_headers())

    headers = {
        **cors_headers(),
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=3600",
    }
    return web.Response(body=audio, headers=headers)


async def handle_static(request: web.Request) -> web.StreamResponse:
    rel = request.match_info.get("path", "").lstrip("/") or "index.html"
    # 防止目录穿越并屏蔽服务端目录本身
    if rel.startswith("tts-server") or ".." in Path(rel).parts:
        raise web.HTTPNotFound()

    target = (ROOT_DIR / rel).resolve()
    if not str(target).startswith(str(ROOT_DIR)) or not target.is_file():
        raise web.HTTPNotFound()

    content_type = MIME_OVERRIDES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    headers = {"Content-Type": content_type}
    if target.name in {"sw.js", "index.html", "app.mjs", "tts.mjs"}:
        headers["Cache-Control"] = "no-cache"
    return web.Response(body=target.read_bytes(), headers=headers)


def get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("223.5.5.5", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def create_app() -> web.Application:
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app.router.add_route("OPTIONS", "/{tail:.*}", handle_options)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/voices", handle_voices)
    app.router.add_post("/api/tts", handle_tts)
    app.router.add_post("/v1/audio/speech", handle_tts)
    app.router.add_get("/", handle_static)
    app.router.add_get("/{path:.*}", handle_static)
    return app


if __name__ == "__main__":
    lan_ip = get_lan_ip()
    print("=" * 56)
    print("页灯听书一体化服务已启动（免费 Edge-TTS · 国内直连）")
    print(f"本机访问：http://127.0.0.1:{PORT}/")
    print(f"手机同一 Wi-Fi（iPhone Edge/Safari）访问：http://{lan_ip}:{PORT}/")
    print(f"OpenAI 兼容 TTS 接口：http://{lan_ip}:{PORT}/v1/audio/speech")
    print("=" * 56)
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
