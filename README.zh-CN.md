# sqlite-remote-sync

> [English (default)](./README.md) · **[中文](./README.zh-CN.md)**

基于 **WebDAV / 任意 HTTP 对象存储** 的双向、无冲突 **SQLite** 同步库，TypeScript 实现，**零运行时依赖**。

所有 JS SQLite 运行时走同一套代码：`kysely-sqlite-tools`、浏览器/OPFS、React Native、Capacitor、Electron、Tauri、Node。核心只依赖 **原始 SQL + 字节对象存储**：不碰 `.db` 文件字节、不用 `EXPORT`/`IMPORT`、不依赖原生模块。快照是逻辑 SQL 转储，因此 wasm/RN 与 Node 行为完全一致。

**特性**

- 双向、离线优先同步，确定性 **LWW-Map** 冲突处理（行级 / 列级字段合并、墓碑删除、HLC 混合逻辑时钟）。
- **多网盘同步**：一个数据库同时镜像到多个网盘/云存储；第三方网盘可通过 [`files-sdk`](./docs/backends.md#files-sdk-third-party) 接入。
- 增量、gzip 压缩、分块 segment —— 500 行最少只产生 **2 个远端对象**；块数与块大小均可配置。
- 逻辑快照 + compact + gc，让 WebDAV 上的对象数是 `O(设备数)` 而非 `O(写入次数)`。
- 可选 **Kysely 插件**，写入完成后立即触发同步。
- **`sqlite-remote-sync/react`** —— React 里直接对 Kysely 增删改查，**数据自动刷新**（本地写入或远端 pull 后 `useQuery` 自动重跑）。见 [React 插件文档](./docs/react.md)。

**在线演示** — 一个带分类 / 标签 / 提醒 / WebDAV 同步 / 导入导出、**中英文切换**的 [Todo·笔记 demo](./demo/)，纯浏览器运行，采用 **TypeScript 7 + Vite 8 + React 19 + kysely-wasm**（SQLite WASM）并使用了上面的 React 插件，可一键部署到 GitHub Pages。默认开启**演示模式**：用 Service Worker 在浏览器内实现一个虚拟 WebDAV 服务器（IndexedDB 存储），**打开两个标签页即可看到真实的双向同步**，无需后端、无需 CORS、无需 COOP/COEP 响应头，见 [demo/README.md](./demo/README.md)。

---

## 安装

```sh
pnpm add sqlite-remote-sync
# 使用 Kysely 时：kysely 是可选 peer（>=0.29）
```

---

## 快速开始（Node）

```ts
import { DatabaseSync } from 'node:sqlite';
import { createSyncEngine, fromRaw, WebDavBackend } from 'sqlite-remote-sync';

const sqlite = new DatabaseSync('app.db');
const db = fromRaw({
  run(sql, params = []) {
    const st = sqlite.prepare(sql);
    if (st.columns().length > 0) return { rows: st.all(...params), changes: 0 };
    const r = st.run(...params);
    return { rows: [], changes: Number(r.changes), insertId: r.lastInsertRowid };
  },
});

const engine = createSyncEngine({
  db,
  backend: new WebDavBackend({
    url: 'https://dav.example.com/remote.php/dav/files/me/',
    username: 'user',
    password: 'app-password',       // 或 token: '...' 使用 Bearer
  }),
  appId: 'my-app',                  // 远端命名空间
  siteId: await loadOrCreateDeviceId(), // 每台设备稳定且唯一
  tables: [
    { name: 'todos', primaryKey: ['id'] },
    { name: 'notes', primaryKey: ['id'] },
  ],
});
await engine.init();

await db.run('INSERT INTO todos (id, title) VALUES (?, ?)', ['t1', 'buy milk']);
await engine.sync();                // 先 pull() 再 push()
engine.startAutoSync(30_000);       // 可选：定时同步
```

`siteId` 必须稳定且全局唯一。所有设备必须使用相同的 `appId`、表配置、`strategy` 和 `resolver`。

---

## React：直接 Kysely 增删改查 + 数据自动刷新

`sqlite-remote-sync/react` 把 Kysely 托管的 SQLite 变成响应式数据源：照常用
Kysely 写库，本地写入或引擎 pull 落地远端改动后，所有 `useQuery` 会自动重跑，
无需手动刷新。

```tsx
import { SyncProvider, useKysely, useQuery, useSync } from 'sqlite-remote-sync/react';

<SyncProvider db={kysely} engine={engine}>
  <Items />
</SyncProvider>

function Items() {
  const db = useKysely<DB>();                       // 用于增删改查的 live Kysely
  const { data } = useQuery<DB['items'][], DB>((d) =>
    d.selectFrom('items').selectAll().execute());  // 数据变化自动重跑
  const sync = useSync();

  return <>{/* db.insertInto(...).execute() 即可，无需手动 render */}</>;
}
```

`createLiveKysely()` 也单独导出，可在非 React 环境使用。完整 API、配置项与注意点见
**[React 插件文档](./docs/react.md)**。React 是可选 peer（`>=18`），`kysely` 同样可选。

---

## 同步到多个网盘

把 `backend` 换成 `backends` 即可：每次写广播到所有网盘，读按优先级回退。详见 **[多网盘同步](./docs/multi-cloud.md)**。

```ts
const engine = createSyncEngine({
  db,
  backends: [
    new WebDavBackend({ url: 'https://dav.jianguoyun.com/dav/', username, password }),
    new WebDavBackend({ url: 'https://cloud.example.com/remote.php/dav/files/me/', token }),
    new FsBackend('/mnt/backup/sync'),        // 本地/离线副本
  ],
  mirror: { writeQuorum: 'all' },             // 默认：任一网盘故障就让同步明确失败
  appId: 'my-app', siteId: deviceId, tables,
});
```

通过 `files-sdk` 接入第三方网盘（S3/R2/GCS/Azure/Vercel Blob/Dropbox/OneDrive/Google Drive/Box/…）：

```ts
import { Files } from 'files-sdk';
import { s3 } from 'files-sdk/s3';
import { FilesSdkBackend } from 'sqlite-remote-sync';

const backend = new FilesSdkBackend({
  files: new Files({ adapter: s3({ bucket: 'my-sync' }) }),
});
```

---

## 工作原理

1. `init()` 安装 `AFTER INSERT/UPDATE/DELETE` 触发器，把本地写入连同 **混合逻辑时钟（HLC）** 时间戳追加到 **outbox**。
2. `push()` 把 outbox 合并成不可变、压缩过的 **segment**，上传到该设备自己的前缀下。
3. `pull()` 只下载超过本设备 **按站点游标** 的 segment，并在 **一个事务** 内应用。
4. 冲突用 **LWW-Map 半格 join**（交换律、结合律、幂等）解决，因此无论投递顺序如何，副本都会收敛。

完整说明见 **[架构](./docs/architecture.md)**。

### 冲突处理（简述）

- `strategy: 'row'`（默认）：行级 LWW，胜者为 `max(p, l, siteId)`，时钟相同也能确定性裁决。
- `strategy: 'field'`：按列 LWW，两个设备改不同列时两边的修改都保留。
- 删除是墓碑，陈旧更新无法让已删除的行复活。
- `resolver` 可传入自定义 `ConflictResolver` —— **必须是半格 join**，否则副本会发散。

完整说明与自定义解析器示例见 **[冲突处理](./docs/conflict-resolution.md)**。

### 分块：避免网盘里出现太多小文件

**一次本地写 ≠ 一个远端文件。** 写入先按 `(table, pk)` 合并；`segmentMaxOps` / `segmentMaxBytes` 把大变更切成有上限的块并行下载；`compact()` 把多个 segment 卷成一个快照，`gc()` 回收旧文件。

想要「500 条 ≈ 10 个文件」：

```ts
const engine = createSyncEngine({
  db, backend, appId: 'my-app', siteId: deviceId, tables,
  segmentMaxOps: 50,            // 500 / 50 = 10 块
  concurrency: 4,
  compactAfterSegments: 200,    // 别让自动 compact 立刻卷回 1 块
});
```

完整说明见 **[使用细节 → 控制块大小](./docs/getting-started.md#controlling-chunk-size)**。

---

## 同步后端

全部实现 `RemoteBackend { get, put, list, head, delete }`。

| 后端 | 导入 | 说明 |
| --- | --- | --- |
| `WebDavBackend` | 主入口 / `./backends` | Basic/Bearer、MKCOL、PROPFIND、`If-Match`、`Range`、重试。适配 Nextcloud/ownCloud/坚果云/群晖/rclone/Apache/nginx。 |
| `GenericHttpBackend` | 主入口 / `./backends` | 极简 REST+ETag 契约；可运行的参考服务端见 [`examples/server.ts`](./examples/server.ts)。 |
| `FilesSdkBackend` | 主入口 / `./backends/files-sdk` | 通过 [`files-sdk`](https://www.npmjs.com/package/files-sdk) 接入第三方网盘：S3/R2/GCS/Azure/Vercel Blob/Dropbox/OneDrive/GDrive/Box/WebDAV/本地 fs。结构化适配，不依赖 `files-sdk`。 |
| `MirrorBackend` | 主入口 / `./backends/mirror` | 多网盘镜像：写广播、读回退、list 联合。 |
| `MemoryBackend` | 主入口 / `./backends` | 测试 / 同进程多窗口。 |
| `FsBackend` | `sqlite-remote-sync/backends/fs` | Node / Electron 本地目录（内容指纹 ETag）。 |

各后端详细配置、网盘接入与自定义后端见 **[同步后端](./docs/backends.md)**。

---

## API

```ts
const engine = createSyncEngine(config);
await engine.init();                  // 安装表/触发器，探测后端能力
await engine.migrate();               // ALTER TABLE 后重建触发器
await engine.push();                  // 上传本地变更
await engine.pull();                  // 下载并应用远端变更
await engine.sync();                  // pull() 然后 push()，推荐入口
await engine.compact();               // 生成快照并合并 segment
await engine.gc();                    // 删除已被确认的 segment
await engine.write(fn);               // 在引擎写锁内执行
await engine.trackChange(table, pk);  // 无触发器环境的显式捕获
engine.startAutoSync(30_000);
engine.stopAutoSync();
const off = engine.on(evt => { /* push | pull | conflict | error | compact */ });
engine.isSyncing();
await engine.close();
```

`sync()` / `push()` / `pull()` 返回 `SyncStats`（推/拉的 op 数、segment 数、字节数、冲突数、耗时）。

### 配置项（除前四项与 `backend`/`backends` 二选一外均可选）

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `db`, `appId`, `siteId`, `tables` | — | 必填 |
| `backend` / `backends` | — | 单个后端，或用 `MirrorBackend` 镜像的数组 |
| `mirror` | — | `MirrorOptions`（`writeQuorum`、`onBackendError`） |
| `strategy` | `'row'` | `'row'` 行级 LWW，`'field'` 按列合并 |
| `resolver` | 内置 | 自定义半格 join |
| `compress` | `true` | 用 `CompressionStream` 做 gzip，或自定义 `Codec` |
| `segmentMaxBytes` | 512 KiB | 大变更分块（未压缩 JSON 字节数） |
| `segmentMaxOps` | 2000 | 大变更分块（合并后的行级 op 数） |
| `blobThreshold` | `0`（关闭） | 大 BLOB 按内容寻址去重 |
| `concurrency` | 4 | 并行下载块数 |
| `compactAfterSegments` | 24 | 自动 compact 阈值 |
| `autoCompact` | `true` | 达到阈值时在 `sync()` 内自动 compact |
| `healInterval` | 10 | 每 N 次同步用 `list()` 对账一次 |
| `clockSkewMs` | 0 | 允许的物理时钟偏移 |
| `retry`, `logger`, `fetch` | — | 退避重试、日志、注入 fetch |

---

## 远端目录结构

```
<appId>/
  manifest/<site>.json                     # 每站点：epoch、resolver、segment 列表、已应用向量
  segments/<site>/<from>-<to>-<hash>.seg  # 不可变、gzip JSON、只追加
  snapshots/<hash>.snap                   # 不可变逻辑快照
  snapshot.json                           # 共享、单调推进的指针
```

---

## 真实 WebDAV 服务器上的验证

`test/webdav-e2e.test.ts` 用进程内 [`webdav-server`](https://www.npmjs.com/package/webdav-server) 通过真实 HTTP 跑完整套库。该服务**不发 ETag、忽略 `If-Match`**，因此整套测试同时覆盖无 CAS 降级路径。性能数据（单次运行、Node 24，仅作量级参考，非基准宣称）：

| 场景 | 请求数 | 对象数 | 备注 |
| --- | --- | --- | --- |
| 500 行 / 5 表，一次 `sync()` | 10 | 2 | 500 op → 1 个 gzip segment（~11 KB）+ 1 个 manifest |
| 新设备全量 pull | 9 | — | 1 个 segment 拿到 500 行 |
| 增量 1 行 `sync()` | 6 | — | `pushedOps=1`，175 B |
| 空转 `sync()` | 2 | — | 0 推 / 0 拉 |
| `segmentMaxOps: 50` | 19 | 11 | 恰好 10 块，并行拉取 |
| 5 设备 × 100 行收敛 | 198 | 10 | 5 manifest + 5 segment |

测量中发现并修复了两个性能问题：每次 WebDAV PUT 后多余的 `HEAD`、并发 PUT 时重复的 `MKCOL`（10 块推送从 35 降到 19 个请求）。`webdav-server` 没有 304，因此每次 pull 都会重新下载所有 manifest —— 需要条件读时请使用支持 ETag 的后端。

---

## 文档导航

> 文档正文以英文撰写；下表是各文档的中文导读。

| 文档 | 内容 |
| --- | --- |
| [Getting started](./docs/getting-started.md) | 生命周期、`write()` 写锁、自动同步、Kysely 插件、事件/统计、错误处理、分块、schema 迁移 |
| [Backends](./docs/backends.md) | 各网盘 WebDAV 配置、REST 契约、`files-sdk` 第三方网盘、自定义后端、ETag/CAS 行为 |
| [Multi-cloud sync](./docs/multi-cloud.md) | `MirrorBackend`、`backends` 配置、一致性与 quorum、故障回退、每云独立库的模式 |
| [Conflict resolution](./docs/conflict-resolution.md) | LWW-Map 语义、`strategy`、自定义解析器、可运行示例、常见坑 |
| [Architecture](./docs/architecture.md) | 线格式、HLC、oplog、segment、manifest、快照、compact、gc、正确性细节 |
| [Frameworks](./docs/frameworks.md) | kysely-sqlite-tools、RN、Capacitor、Electron、Tauri、OPFS/worker 的详细接线 |
| [React 插件](./docs/react.md) | `sqlite-remote-sync/react`：`SyncProvider` / `useQuery` / `useKysely`，实时查询与数据自动刷新 |
| [examples](./examples/) | 可运行的 REST/ETag 参考服务端 |

---

## 要求与限制

- SQLite ≥ 3.42 可获得毫秒级 HLC；旧版本回退到 `strftime('%s','now')*1000`（仍正确，精度更粗）。`init()` 会探测能力并优雅降级。
- 表需要**稳定的主键**。DDL 变更由你的应用管理（Kysely migrations），之后每台设备调用 `migrate()`。
- 一个数据库一个同步引擎。建议单写连接；并发应用写入用 `engine.write()`。
- 所有设备必须使用相同的 `tables`、`strategy`、`resolver` 和 codec（由 `schemaEpoch` 与 manifest 校验强制）。
- 墙钟偏移只影响 LWW **哪个写入胜出**，不影响收敛。需要更强语义请用 `'field'` 或自定义解析器。
- 无触发器环境：每次写后调用 `engine.trackChange(table, pkValues)`。
- `MirrorBackend` / `FilesSdkBackend` **刻意不使用 CAS/304**（其无 CAS 路径依然完全正确）；如需条件读请用单个支持 ETag 的后端。

---

## 开发

本项目使用 **pnpm**（`packageManager` 已锁定，`pnpm-lock.yaml` 是唯一 lockfile）。

```sh
pnpm install
pnpm run typecheck
pnpm test              # 全部套件：真实 webdav-server E2E + 性能 + 多网盘 + files-sdk + Kysely
pnpm run test:e2e      # 仅真实 WebDAV E2E / 性能套件
pnpm run build         # ESM + .d.ts 输出到 dist/
pnpm run qa            # typecheck + test + build
pnpm tsx examples/server.ts   # 参考 REST/ETag 服务端
```

全套 **66 个测试**：值编码、HLC、触发器捕获、回放守卫、LWW 收敛、墓碑、字段合并、幂等、分块、快照、CAS re-base、真实 WebDAV（双向/冲突/compaction/并发/性能）、多网盘镜像、`files-sdk` 适配、Kysely 插件。

## 许可证

[MIT](./LICENSE) — 见 [LICENSE](./LICENSE)。
