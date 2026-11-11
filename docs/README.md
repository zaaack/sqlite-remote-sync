# Documentation / 文档导航

> [← English README](../README.md) · [中文 README](../README.zh-CN.md)

Documentation is written in **English** (the project default). The Chinese README
contains a [Chinese guide to every document](../README.zh-CN.md#文档导航).

文档正文以英文撰写（项目默认语言）。中文 README 里有[每篇文档的中文导读](../README.zh-CN.md#文档导航)。

---

## English

| Document | What it covers |
| --- | --- |
| [Getting started](./getting-started.md) | Lifecycle, `write()` lock, auto-sync, Kysely plugin, events & stats, error handling, chunk size, schema migration, maintenance |
| [Backends](./backends.md) | `RemoteBackend` contract, WebDAV providers, REST/ETag server, `files-sdk` third-party drives, custom backends, ETag/CAS behaviour |
| [Multi-cloud sync](./multi-cloud.md) | `MirrorBackend`, `backends` config, consistency & quorum, failover, independent-DB-per-cloud pattern |
| [Conflict resolution](./conflict-resolution.md) | LWW-Map semantics, `row` vs `field`, custom `ConflictResolver` (with worked examples), pitfalls |
| [Architecture](./architecture.md) | Wire format, HLC, oplog, segments, manifests, snapshots, compaction, gc, crash safety |
| [Frameworks](./frameworks.md) | Wiring for kysely-sqlite-tools dialects, React Native, Capacitor, Electron, Tauri, browser OPFS/worker |
| [Examples](../examples/) | Runnable REST/ETag reference backend |

### Start here

1. [Install + quick start](../README.md#quick-start-node).
2. [Choose a backend](./backends.md#choosing-a-backend).
3. [Understand conflicts](./conflict-resolution.md) before picking `strategy` / `resolver`.
4. [Tune chunking](./getting-started.md#controlling-chunk-size) if you care about the number of remote files.
5. [Add more clouds](./multi-cloud.md) when you need redundancy.

---

## 中文

| 文档 | 内容 |
| --- | --- |
| [Getting started](./getting-started.md) | 生命周期、`write()` 写锁、自动同步、Kysely 插件、事件与统计、错误处理、分块大小、schema 迁移、维护 |
| [Backends](./backends.md) | `RemoteBackend` 契约、各网盘 WebDAV 配置、REST/ETag 服务端、`files-sdk` 第三方网盘、自定义后端、ETag/CAS 行为 |
| [Multi-cloud sync](./multi-cloud.md) | `MirrorBackend`、`backends` 配置、一致性与 quorum、故障回退、每云独立库模式 |
| [Conflict resolution](./conflict-resolution.md) | LWW-Map 语义、`row` 与 `field`、自定义 `ConflictResolver`（含示例）、常见坑 |
| [Architecture](./architecture.md) | 线格式、HLC、oplog、segment、manifest、快照、compact、gc、崩溃安全 |
| [Frameworks](./frameworks.md) | kysely-sqlite-tools 各 dialect、React Native、Capacitor、Electron、Tauri、浏览器 OPFS/worker 接线 |
| [Examples](../examples/) | 可运行的 REST/ETag 参考服务端 |

### 阅读顺序

1. [安装与快速开始](../README.zh-CN.md#快速开始node)。
2. [选择后端](./backends.md#choosing-a-backend)。
3. 选 `strategy` / `resolver` 前先读[冲突处理](./conflict-resolution.md)。
4. 在意远端文件数量就读[分块调优](./getting-started.md#controlling-chunk-size)。
5. 需要冗余备份时读[多网盘同步](./multi-cloud.md)。
