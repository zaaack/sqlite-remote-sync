# Sync Notes — Todo / 笔记 demo

一个纯前端、离线优先的 Todo / 笔记应用，直接跑在 GitHub Pages 上，**打开两个标签页就能看到实时同步**。

技术栈：**TypeScript 7 + Vite 8 + pnpm 12 + React 19 + kysely-wasm**，使用本仓库
`sqlite-remote-sync` 的 `createSyncEngine`、`WebDavBackend` 与 **`sqlite-remote-sync/react`** 插件。
仓库是 pnpm workspace，`demo/` 通过 `workspace:*` 依赖主库。

## 在 GitHub Pages 上直接演示同步（无需任何服务器）

默认就是 **演示模式**：`public/sw.js` 是一个 Service Worker，它在浏览器里实现了一个
**虚拟 WebDAV 服务器** —— 拦截同源的 `/__dav__/` 请求，用 IndexedDB 存文件，支持
`GET / PUT / HEAD / DELETE / MKCOL / PROPFIND`、`207 Multi-Status`、`ETag` +
`If-Match` / `If-None-Match`（412 CAS）和 `Range`。

IndexedDB 和 Service Worker 都是**同源所有标签页共享**的，所以两个标签页等价于两台设备
连着同一个 WebDAV 服务。demo 用的是库里**未经修改的 `WebDavBackend` + 真实同步引擎**
（outbox、逐字段 LWW、墓碑、gzip、CAS），不是 mock 同步。

操作步骤：

1. 打开部署好的 Pages 页面。
2. 点顶部提示条里的 **「打开第二个标签页 / Open a second tab」**（按钮会给新标签页分配独立的设备 id）。
3. 在任一标签页新建 / 编辑 / 删除一条，另一个标签页**无需刷新、无需点击**就会自动更新。

改动即时同步来自 Service Worker 的广播：写入 segment 后 SW 向所有标签页发消息，
另一端 debounce 后调用 `engine.sync()`；`sqlite-remote-sync/react` 的 `useQuery`
收到引擎 `pull` 事件后自动重跑。另有 10 秒自动同步兜底。

每个标签页有独立的 `siteId`（`sessionStorage` + `?tab=` 覆盖）和独立的本地 SQLite 文件
（IndexedDB key 按标签页区分），互不当成同一台设备。设置里可一键清空演示服务数据，
会广播给所有标签页一起重置。

### 为什么不用 WebContainers

WebContainers 在 GitHub Pages 上不适合这个目标：

- 需要文档响应头 `COOP: same-origin` + `COEP: require-corp|credentialless`，
  而 **GitHub Pages 不能设置自定义响应头**（`coi-serviceworker` 可注入，但要强制首访重载）。
- `WebContainer.boot()` 每页只能有一个实例，每个标签页各跑一份隔离的 Node.js / 文件系统，
  标签页之间天然不共享；要互通还得把 PROPFIND/PUT 转发到某个标签页的随机 `*.webcontainer.io`
  代理地址，跨域隔离 + CORS 预检会拦住。
- 运行时闭源、从 StackBlitz 服务器加载（约 75–85 MB、冷启动约 6.6 s、仅 Chromium），
  商业生产使用还需要商业授权 —— 一个「自包含的 Pages demo」反而依赖了第三方服务。

Service Worker 方案零外部依赖、零响应头、全浏览器可用、同源标签页天然共享状态。

## 功能

- Todo / 笔记；分类、标签、视图、搜索、排序
- 截止时间 + 提醒（页面内提醒 + 桌面通知）
- WebDAV 双向同步，逐字段 LWW 冲突合并（`strategy: 'field'`）
- JSON 导入 / 导出、真 `.sqlite` 文件导出
- **中英文切换**（顶栏 `EN / 中文` 按钮；偏好写入 localStorage，会同步到其他标签页）
- **数据自动刷新**：增删改查直接走 Kysely 查询构造器，`useQuery` 结果自动更新，无任何手动 `render()`

## 三种同步模式（⚙ 设置里切换）

| 模式 | 后端 | 说明 |
| --- | --- | --- |
| **演示模式**（默认） | `WebDavBackend` → Service Worker 虚拟 WebDAV | 无需配置，多标签页实时同步 |
| **自定义 WebDAV** | `WebDavBackend` → 真实服务 | 填地址 / 凭据 / 命名空间 |
| **仅本地（离线）** | `MemoryBackend` | 不连远端，改动留在 outbox |

## 本地运行

需要 Node ≥ 20.19（Vite 8 要求），仓库已声明 `packageManager: pnpm@12.21.0`（corepack 自动启用）。

```sh
# 在仓库根目录执行
pnpm install
pnpm build:demo          # 先编译主库 dist/，再 tsc --noEmit + vite build → demo/dist/
pnpm dev:demo            # 开发服务器（Vite HMR）
```

预览构建产物：

```sh
cd demo/dist && python3 -m http.server 8080
```

> Service Worker 需要 HTTPS 或 `localhost`，所以请通过 HTTP(S) 访问，不要用 `file://` 打开。
> `demo` 的 `tsc --noEmit` 解析的库类型来自主库 `dist/`，单独构建 demo 前需先 `pnpm build`；
> 用根目录的 `pnpm build:demo` 会自动按顺序处理。

## 部署到 GitHub Pages

仓库自带 [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)：push 到 `main`
（或手动 `workflow_dispatch`）时用 pnpm 12 安装、执行 `pnpm build:demo`，把 `demo/dist`
上传为 Pages artifact 并部署。

**一次性设置**：仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。

- Vite `base: './'` 让资源在项目子路径 `https://<user>.github.io/<repo>/` 下也能加载。
- `public/sw.js` 会被原样复制到 `dist/sw.js`（必须和 `index.html` 同目录，不能打包进 bundle）。
  SW 注册 scope 取当前目录，项目子路径同样有效；`public/.nojekyll` 一并复制到 `dist/`。
- 无需任何 COOP/COEP 响应头、无需 CORS、无需后端。

## 架构 / 数据流

```
sql.js (WASM) ──► SqlJsDialect (kysely-wasm) ──► Kysely<DB>
                       │                                │
              fromKysely(db)                  <SyncProvider db engine>
                       │                                │
              createSyncEngine              useKysely() / useQuery()
                       │                                │
        WebDavBackend ─┼─► fetch('/__dav__/…')   React 组件（自动刷新）
                       │          │
                       │   Service Worker (public/sw.js)
                       │          │  IndexedDB（同源所有标签页共享）
                       │     ┌────┴────┐
                       │   标签页 A   标签页 B   ← 各自独立的本地 SQLite + siteId
                       │
                       └─ (自定义模式) ─► 真实 WebDAV 服务（需 CORS）
                       └─ (仅本地模式) ─► MemoryBackend
```

- `public/sw.js` — 虚拟 WebDAV 服务器；`src/virtual-dav.ts` — 注册 SW、拿到 controller、
  生成演示 URL、`X-Demo-Tab` 头、清空远端。
- `src/tab.ts` — 每标签页独立 id（`?tab=` 优先，否则 sessionStorage）。
- `src/db.ts` — sql.js WASM、按标签页分 key 的 IndexedDB 持久化、建表、
  `fromKysely(db, { compiledQuery: CompiledQuery.raw })`。
- `src/sync.ts` — 三种模式、`siteId`、`createSyncEngine`（`strategy: 'field'`、`compress`、
  retry、自动同步）。
- `src/i18n.ts` — 中英文字典、`useSyncExternalStore` 语言状态、`localStorage` 持久化、
  `storage` 事件跨标签页同步、首启示例数据。
- `src/App.tsx` — React UI；读取全部来自 `useQuery`，写入全部经 `useKysely()`；
  监听 SW 广播触发 `engine.sync()`。
- `src/main.tsx` — 启动引导（SW → WASM/IDB → 引擎 → 示例数据 → 首次同步 → 渲染）。

### 数据自动刷新怎么来的

`sqlite-remote-sync/react` 的 `SyncProvider` 用 `createLiveKysely()` 给 Kysely 挂了
observer 插件：`insertInto` / `updateTable` / `deleteFrom` 成功后发出失效通知；同时监听
引擎的 `pull` 事件，远端改动落地后也发通知。`useQuery` 订阅通知并重跑查询。引擎自身的
replay/ingest 写入走 `executeQuery(RawNode)`，被插件排除，不会造成反馈循环。

同理，SW 的广播只针对 `segments/` / `snapshots/` 这类数据文件，不针对 manifest 的
`ackApplied()` 回写，避免两个标签页互相触发无限同步。

完整 React 插件 API 见 [`docs/react.md`](../docs/react.md)。

首次运行插入 3 条示例数据，使用**固定 id**，因此两个标签页各自初始化也不会同步出重复行；
示例内容按首次启动时的语言生成（用户内容不会随语言切换被翻译）。

## 自定义 WebDAV 与 CORS

在「⚙ 设置」里选 **自定义 WebDAV**，填地址、可选用户名/应用密码或 Bearer Token，
以及命名空间 `appId`（多设备必须一致）。凭据只存在本浏览器 `localStorage`。

页面运行在 GitHub Pages 上，真实 WebDAV 通常是另一个域，**浏览器直连要求服务端开启 CORS**：

- 允许方法：`GET, PUT, DELETE, HEAD, PROPFIND, MKCOL, OPTIONS`
- 允许请求头：`Authorization, Depth, If-Match, If-None-Match, Content-Type`
- 响应头 `Access-Control-Allow-Origin`，并通过 `Access-Control-Expose-Headers: ETag`
  暴露 `ETag`（库用它做 CAS 条件写）
- 正确响应 `OPTIONS` 预检

多数默认配置的网盘不允许，需要一台开了 CORS 的 WebDAV 服务或同源反向代理。
**切回演示模式即可完全免配置。**

## 导入 / 导出 / 提醒

- 导出 JSON（可再导入）、导出真 `.sqlite` 文件（`SQLite format 3`）。
- 导入 JSON：按 `id` upsert，列表自动刷新，并会同步到其他标签页。
- 提醒只在页面打开时检查（GitHub Pages 没有后端推送）；授予桌面通知权限后会弹系统通知。
  改过截止时间/提醒间隔会重新武装提醒。

## 已知限制

- 演示数据存在本浏览器 IndexedDB（按标签页区分本地 SQLite + 共享的虚拟 WebDAV 存储）；
  清浏览器数据会清空。不同访客之间互不可见（IndexedDB 按 origin 隔离，这本就是预期行为）。
- 标签页关闭再打开会分配新的 `siteId`，本地 SQLite 重新初始化，但可从虚拟 WebDAV 拉回全部数据。
- 提醒依赖页面打开；`useQuery` 目前对任意改动都会重跑所有活跃查询（无表级失效），对本地小库足够。
- 用 `sql\`...\`.execute()` 之类绕过 Kysely 查询构造器的写入不会自动通知，需调用
  `useLiveKysely().notify()`；本 demo 未使用这类写入。

## 目录

```
demo/
├── index.html            Vite 入口
├── vite.config.ts        base: './'、@vitejs/plugin-react
├── tsconfig.json         TS7 (strict, react-jsx)
├── public/
│   ├── .nojekyll
│   └── sw.js             虚拟 WebDAV Service Worker（独立文件，不打包）
├── src/
│   ├── main.tsx          启动引导 + 固定 id 示例数据
│   ├── App.tsx           React UI（全部走 react 插件）
│   ├── db.ts             sql.js + kysely-wasm + IndexedDB（按标签页分 key）
│   ├── sync.ts           三种同步模式 / 引擎 / siteId
│   ├── virtual-dav.ts    SW 注册、演示 URL、广播头、清空
│   ├── tab.ts            每标签页独立身份
│   ├── i18n.ts           中英文字典 + 语言状态
│   ├── types.ts          DB / Item / Settings
│   ├── styles.css
│   └── vite-env.d.ts
└── dist/                 构建产物（不入库，由 CI 生成）
```
