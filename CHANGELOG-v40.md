# 页灯 v40 修改记录

基线为 GitHub `main` 的 v39 提交 `1222568`。本次修复集中在离线启动、整本替换及私人云书库的数据完整性。

## 前端

| 文件 | 修改 |
| --- | --- |
| `sw.js`、`index.html`、`app.mjs` | 静态资源版本统一为 v40。离线首页预缓存使用应用目录地址，避开 Pages 的 `/index.html` 重定向。「检查更新」核验 HTTP 响应和版本号，沿用 Service Worker 的更新流程。 |
| `download.mjs`、`storage.mjs` | 「重新下载整本」将已完成章节按批次存到任务草稿。暂停、失败或刷新后只补剩余章节。全部正文就绪才替换书架原文。两个续跑入口都校验目录顺序，原正文缺失时停止增量写入，保存失败保留可重试状态。 |
| `reader-core.mjs`、`app.mjs` | 已下载书优先按有效的章节清单生成阅读目录。普通 TXT 和旧清单仍可使用标题识别。 |
| `tts.mjs` | 本章定时暂停后从下一章对应音轨续播。自定义 TTS 接口拒绝多角色请求时，用标准单音色请求再试一次。 |

## 云书库

- `sync.mjs` 按正文版本时间和哈希同步，覆盖等长修订和正文缩短的情形。下载固定到指定版本并校验 SHA-256，每次同步使用启动时的同步码。旧备份恢复时优先保留本机较新的正文。
- `app.mjs` 和 `sync.mjs` 为书签记录修改与删除时间。显式重新添加可以恢复同一位置的书签。打开缺正文的下载书时，将恢复的正文和对应清单一起保存。
- `worker.js` 新增 `book_upload_chunks` 和 `book_active_uploads` 两张表，首次请求云书库时由 D1 自动建表。只有收到全部分片，才在一个 D1 批处理中发布正文、版本和元数据。迟到的请求保留较新的阅读断点，书签删除标记随元数据合并。[Cloudflare D1 批处理文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- `worker.js` 的番茄路由单独响应跨域预检，允许该路由使用 `X-Fanqie-Cookie`。

## 兼容和发布

- 现有的 `dl.manifest`、整库备份文件格式和 IndexedDB 版本继续可用。重下草稿用 `texts` 表的独立数组键存储。旧目录或损坏清单可从书架重新下载整本。
- 旧 D1 正文继续从 `book_chunks` 读取。该表也保存 v40 成功发布的正文，可供回滚版本读取。部署 v40 后，仍停留在旧页面的客户端上传正文会收到 409，刷新到 v40 后可重试。已有损坏的 v39 云正文需要从可靠的本机副本或备份重新上传。
- 前端和 `_worker.js` 要随同一个 ZIP 做 Cloudflare Pages Direct Upload，使用项目现有的 `DB` 绑定。发布后验证两个域名的 `/health`、番茄健康接口、空 TTS 请求和 `sw.js` 版本。另用测试同步码验证双端恢复，并在 iPhone 上检查离线重开、更新接管和锁屏续播。
- 本次部署包位于 `D:\dsh\book\_artifacts\v40\yeding-pages-deploy.zip`。项目脚本生成 14 个暂存文件后，当前环境的 PowerShell 压缩模块加载失败。本次用 Python 标准库从同一批暂存文件完成 ZIP，已检查文件清单、CRC 和 `_worker.js` 语法。

## 验证

共通过 15 组回归场景。所有已跟踪 JavaScript 模块通过 `node --check`。

- 2026-11-28 生产验收通过。两个域名的 HTML 和 Service Worker 均返回 v40，D1 书库查询和番茄健康接口返回 200，TTS 空请求正常返回 400。Pages 域名在桌面浏览器断网重载后仍能打开书架。
- `D:\dsh\book\_artifacts\v40\sync-check.mjs` 使用内存 SQLite 调用真实 Worker 路由，覆盖迟到写入、分片中断、旧正文读取、版本切换、书签、备份和跨域响应。
- `D:\dsh\book\_artifacts\v40\reader-check.mjs` 覆盖 Pages 重定向与离线缓存、重下暂停和补漏、队列错误、章节目录和两条听书路径。
