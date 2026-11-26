# 页灯听书 · 免费国内直连 Edge-TTS 部署指南

本目录提供两套 **完全免费、支持国内不开代理直连、支持 iPhone Edge/Safari 锁屏连续听书** 的 Edge-TTS 服务端模板。

---

## 方案一：本机 / NAS / 轻量服务器一体化部署（最稳、无需域名、无需代理）

适合家里有 Windows/Mac 电脑、群晖/飞牛 NAS 或国内轻量服务器的用户。启动后会**同时托管页灯前端与 `/api/tts` 接口**，手机打开即听，不需要填任何接口地址。

### 1. 直接 Python 运行
```bash
pip install -r tts-server/local-python/requirements.txt
python tts-server/local-python/server.py
```

启动后终端会打印类似：
```text
手机同一 Wi-Fi（iPhone Edge/Safari）访问：http://192.168.1.100:8787/
```
在 iPhone 的 **Edge 浏览器** 打开这个地址，导入 TXT，点阅读菜单里的「听书」即可直接体验微软晓晓/云希 AI 朗读，并且支持锁屏连续播控。

> 想出门在外用 5G 也能免费不开代理连回自家电脑/NAS：在电脑和 iPhone 上安装免费的 **Tailscale** 或 **ZeroTier**，用内网固定 IP 访问即可。

### 2. Docker 运行（在项目根目录执行）
```bash
docker build -f tts-server/local-python/Dockerfile -t yeding-reader-tts .
docker run -d -p 8787:7860 --name yeding-reader-tts yeding-reader-tts
```
如需加访问密码，加参数 `-e TTS_API_KEY=你的密码`。

---

## 方案二：Cloudflare Worker + 自定义域名（0 元公网 24 小时在线、国内直连）

如果你把页灯前端部署在 GitHub Pages / Cloudflare Pages 等静态站，想随时随地用 iPhone 流量不开代理听书，按以下步骤部署免费语音代理：

1. 注册/登录免费 [Cloudflare 控制台](https://dash.cloudflare.com/)，确保你有一个托管在 Cloudflare DNS 下的自定义域名（因为默认的 `*.workers.dev` 在国内无法直连，但**绑定你自己的子域名后即可国内直连**）。
2. 进入 **Workers & Pages** → **Create Worker** → 部署后点 **Edit code**。
3. 把 `tts-server/cloudflare-worker/worker.js` 全选复制粘贴进去，点击 **Deploy**。
4. （可选）在 Worker 的 **Settings → Variables and Secrets** 添加 `API_KEY`，防止接口被他人调用。
5. 在 Worker 的 **Settings → Domains & Routes → Add Custom Domain** 绑定一个子域名，例如 `tts.yourdomain.com`。
6. 打开页灯阅读器 → 点击正文中央打开菜单 → 点 **「听书」** → 点底部 **「设置」**：
   - 接口地址填写：`https://tts.yourdomain.com/v1/audio/speech`
   - 若设置了 `API_KEY`，填入访问密钥
   - 点 **「测试连接并试听」**，听到提示音后即可正常使用！

---

## iPhone Edge / Safari 锁屏听书小贴士

1. **首次点击开始**：打开书籍后手动点一次「听书」或「播放」按钮，以解锁 iOS 音频播放会话。
2. **锁屏控制**：播放开始后直接按电源键锁屏即可继续连播；锁屏界面和蓝牙耳机支持暂停/继续、切换上一段/下一段。
3. **无网络或未配服务时**：可在「听书设置」切换为「浏览器原生（离线）」作为兜底（但 iOS 系统会在锁屏后暂停原生语音合成，锁屏连播请保持「在线 AI 语音」模式）。
