// 生成 Cloudflare Pages Direct Upload 用的 ZIP：
//   13 个静态文件 + 单文件 _worker.js（worker.js 已内联 fanqie 模块，这里只把末尾 404 兜底换成 ASSETS）
//
// 用法（在本目录或任意位置）：node tts-server/cloudflare-worker/build-pages-zip.mjs [输出目录]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const outDir = path.resolve(process.argv[2] || path.join(process.env.USERPROFILE || '.', 'Desktop'));
const stage = path.join(outDir, 'yeding-stage');
const zipPath = path.join(outDir, 'yeding-pages-deploy.zip');
const workerPath = path.join(here, 'worker.js');

const STATIC_FILES = [
  'index.html', 'styles.css', 'app.mjs', 'download.mjs', 'reader-core.mjs', 'storage.mjs',
  'tts.mjs', 'sync.mjs', 'sw.js', 'manifest.webmanifest',
  'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
];

const NEEDLE = "return Response.json({ error: 'Not Found' }, { status: 404, headers: corsHeaders() });";

let worker = fs.readFileSync(workerPath, 'utf8');
const last = worker.lastIndexOf(NEEDLE);
if (last < 0) throw new Error('worker.js 里找不到末尾 404 兜底');
// 只替换最后一处：/api/sync 处理器里还有一处同名兜底，全量替换会让未知 sync 路由返回网页
worker = `${worker.slice(0, last)}return env.ASSETS.fetch(request);${worker.slice(last + NEEDLE.length)}`;

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of STATIC_FILES) {
  const src = path.join(repo, f);
  if (!fs.existsSync(src)) throw new Error(`缺少静态文件：${f}`);
  fs.copyFileSync(src, path.join(stage, f));
}
fs.writeFileSync(path.join(stage, '_worker.js'), worker, 'utf8');

fs.rmSync(zipPath, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${zipPath}' -Force`], { stdio: 'pipe' });

console.log('stage:', stage);
console.log('files:', fs.readdirSync(stage).length);
console.log('zip:', zipPath, fs.statSync(zipPath).size, 'bytes');
console.log('ASSETS 兜底:', (worker.match(/env\.ASSETS\.fetch\(request\)/g) || []).length, '处');
