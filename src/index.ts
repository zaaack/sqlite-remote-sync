export * from './core/types.js';

export { createSyncEngine } from './core/engine.js';
export {
  fromRaw,
  fromKysely,
  fromExecutor,
  probeCapabilities,
  createMutex,
} from './core/adapter.js';
export type {
  RawSqlClient,
  KyselyLike,
  KyselyAdapterOptions,
  CompiledQueryLike,
  GenericSqliteExecutor,
} from './core/adapter.js';

export { lwwResolver, fieldLwwResolver, joinCells, resolveResolver } from './core/resolver.js';
export { compareTs, isNewer, maxTs } from './core/clock.js';
export {
  identityCodec,
  createGzipCodec,
  resolveCodec,
  cellEncode,
  cellDecode,
  rowEncode,
  rowDecode,
  pkEncode,
  pkDecode,
} from './core/codec.js';
export type { Codec } from './core/types.js';

export { MemoryBackend } from './remote/memory.js';
export { GenericHttpBackend } from './remote/http.js';
export type { GenericHttpBackendOptions } from './remote/http.js';
export { WebDavBackend, parsePropfind } from './remote/webdav.js';
export type { WebDavBackendOptions } from './remote/webdav.js';
export { MirrorBackend } from './remote/mirror.js';
export { FilesSdkBackend } from './remote/files-sdk.js';
export type {
  FilesSdkLike,
  FilesSdkBackendOptions,
} from './remote/files-sdk.js';
export type { MirrorOptions, MirrorError } from './core/types.js';
export { CasConflictError, NotFoundError, RemoteError, probeIfMatch } from './remote/backend.js';
export { createLayout, parseSegmentName, safeSite } from './remote/manifest.js';
export type { Layout, SiteManifest, SegmentDesc, SnapshotPointer } from './remote/manifest.js';

export { createSyncPlugin, attachSyncPlugin } from './kysely-plugin.js';
export type { SyncPluginOptions, SyncKyselyPlugin } from './kysely-plugin.js';
