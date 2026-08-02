# 加解密性能优化分析

## 1. 结论摘要

本项目的加解密速度仍有较大的深入优化空间，但最值得优先处理的并不是替换 AES-GCM 算法。

当前大文件的主要处理链路是：

```text
完整读取并计算内容 SHA-256
  -> 读取文件分片
  -> AES-GCM 加密全部分片
  -> 将全部密文写入 IndexedDB
  -> 逐个计算上传请求摘要和签名
  -> 串行上传全部分片
```

在这条链路中，以下成本会被用户统一感知为“加密很慢”：

- 大文件内容哈希使用纯 TypeScript SHA-256，速度明显低于浏览器原生实现。
- 哈希、加密、缓存和上传基本按阶段串行执行，CPU、磁盘和网络不能充分重叠。
- IndexedDB 使用大对象保存所有分片，缓存清理还会读取全部密文。
- 默认 4 MiB 分片会产生较多请求，每个请求都有哈希、签名、鉴权和 OpenList 往返成本。
- 服务端处理上传时需要先完整接收并落临时文件，再重新读取并转发给 OpenList。

建议优先优化顺序：

1. 替换大文件纯 TypeScript SHA-256。
2. 将加密、缓存和上传改成有界流水线。
3. 将 IndexedDB 缓存拆分为元数据和独立分片。
4. 调整分片大小、上传并发和限流策略。
5. 减少服务端对 OpenList 的重复查询和目录创建。
6. 最后再处理 Worker 初始化、数据复制等局部开销。

不建议现阶段优先替换 AES-GCM。当前实现调用浏览器 Web Crypto，能够使用浏览器和硬件提供的原生优化；切换到 JavaScript 或 WASM 密码算法会增加安全审计和兼容成本，实际收益通常低于优化外围数据路径。

## 2. 当前实现概览

### 2.1 加解密位置

大数据的 AES-GCM 加解密都在浏览器端进行：

- `frontend/src/crypto.ts:128`：普通内容和分片的 AES-GCM 加密。
- `frontend/src/crypto.ts:159`：普通内容和分片的 AES-GCM 解密。
- `frontend/src/crypto_worker.ts`：在 Worker 中调用 Web Crypto。
- `frontend/src/crypto_worker_client.ts`：主线程与 Worker 之间传输分片。

服务端不会解密内容，只负责：

- 校验请求签名。
- 暂存上传请求并计算 SHA-256。
- 将密文转发到 OpenList。
- 从 OpenList 获取密文并流式返回客户端。

因此，服务端算法优化不会提高 AES 本身的吞吐，但会显著影响端到端上传和下载耗时。

### 2.2 大文件上传路径

相关代码位于 `frontend/src/App.tsx:878` 至 `frontend/src/App.tsx:957`。

优化前基线步骤如下：

1. `sha256Input` 完整扫描文件并计算明文内容哈希，用于去重和缓存键。
2. `encryptInputChunks` 并发读取和加密所有分片。
3. 所有密文分片作为一个缓存对象写入 IndexedDB。
4. 等待全部加密和缓存操作结束。
5. 在 `for ... of` 循环中逐片串行上传。

这能实现失败重试时复用密文，但也造成首个上传请求启动较晚、内存峰值较高。当前代码已按 4.2 和 4.3 节改为有界流水线与分片级缓存。

### 2.3 大文件下载路径

相关代码位于 `frontend/src/App.tsx:1746` 至 `frontend/src/App.tsx:1764`。

下载已经使用最多三路并发，将每个分片的“下载 + 解密”组合执行。全部分片完成后，再通过 `concatBytes` 分配完整文件大小的缓冲区并复制所有明文。

这种方式适合图片预览和剪贴板写入，但对于纯文件下载，会额外保留所有分片和一份拼接后的完整文件，峰值内存可能接近文件大小的两倍。

## 3. 基准数据

### 3.1 测试环境

- CPU：4 核 ARM Cortex-A72，最高 1.8 GHz。
- 内存：约 4 GiB。
- 浏览器：Chromium 148，无界面模式。
- 测试日期：2026-07-24。

这些数据用于判断瓶颈构成，不应直接当作所有桌面和移动设备的绝对性能。发布前仍应在实际目标设备上重复测试。

### 3.2 64 MiB 单次吞吐

| 操作 | 耗时 | 吞吐 |
| --- | ---: | ---: |
| Web Crypto AES-GCM 加密 | 5.07 s | 12.6 MiB/s |
| Web Crypto AES-GCM 解密 | 5.29 s | 12.1 MiB/s |
| Web Crypto SHA-256 | 1.53 s | 41.9 MiB/s |
| 当前纯 TypeScript SHA-256 | 14.53 s | 4.4 MiB/s |

结论：在该设备上，当前纯 TypeScript SHA-256 比原生 SHA-256 慢约 9.5 倍，也比 AES-GCM 慢约 3 倍。

对一个 64 MiB 文件，当前上传前的理论计算时间约为：

```text
纯 TypeScript SHA-256 14.53 s + AES-GCM 5.07 s = 19.60 s
```

如果哈希能够达到本机原生 Web Crypto 的水平，则约为：

```text
原生 SHA-256 1.53 s + AES-GCM 5.07 s = 6.60 s
```

这意味着只优化内容哈希，上传前计算阶段就可能接近 3 倍提速。

### 3.3 AES 并发测试

使用三个 16 MiB Web Crypto AES-GCM 请求测试时：

| 并发数 | 聚合吞吐 |
| ---: | ---: |
| 1 | 9.6 MiB/s |
| 2 | 10.8 MiB/s |
| 3 | 10.3 MiB/s |

在这个设备上，并发从 1 提高到 2 只有小幅收益，提高到 3 后没有继续增长。原因可能包括：

- 浏览器密码任务内部已经使用线程池。
- ARM 设备的内存带宽成为限制。
- Web Crypto 实现可能对任务进行串行或有限调度。
- 多任务增加数据搬运和调度成本。

因此，`frontend/src/App.tsx:98` 的固定最大并发数 3 不应被视为所有设备上的最优值。

## 4. 可优化点

## 4.1 P0：优化大文件内容 SHA-256

### 优化前问题

`frontend/src/App.tsx:2427` 中：

- 内存中的 `Uint8Array` 使用 `crypto.subtle.digest`。
- `File` 对象为了避免一次性载入内存，使用 `frontend/src/sha256.ts` 的纯 TypeScript 流式实现。

浏览器 Web Crypto 没有标准流式 digest API，因此当前方案在内存安全和计算速度之间选择了前者。但纯 TypeScript 实现会占用主线程，并成为低性能设备上的首要瓶颈。

### 建议方案

采用分级策略：

1. 已在内存中的短 `Uint8Array` 继续使用 `crypto.subtle.digest`。
2. 所有 `File`/`Blob` 使用成熟的 `hash-wasm` 流式 SHA-256，避免 `file.arrayBuffer()` 将整个文件载入内存。
3. 将 Blob 哈希放入专用 module Worker，避免纯 JavaScript/WASM 计算占用界面线程。
4. 保留当前 TypeScript `Sha256` 作为 Worker、WASM 初始化或 Blob 流读取失败时的兼容回退。

这里不按文件大小把 Blob 切回 `file.arrayBuffer()`：Web Crypto 标准 `digest()` 不提供流式输入，直接调用需要完整 `BufferSource`。统一流式路径可稳定控制内存；小输入已经以 `Uint8Array` 形式存在时，才适合直接使用 Web Crypto。

### 已实施（2026-08-02）

- 新增 `hash-wasm@4.12.0`，使用其 `createSHA256() -> init() -> update(chunk) -> digest('binary')` 增量 API。
- 新增 `frontend/src/sha256_worker.ts`：在单个 module Worker 中复用已初始化的 WASM hasher，并串行执行任务以避免共享哈希状态并发污染。
- 新增 `frontend/src/sha256_stream.ts`：优先通过 `Blob.stream()` 读取，旧浏览器回退到 `Blob.slice().arrayBuffer()` 的 4 MiB 分段读取。
- 新增 `frontend/src/sha256_worker_client.ts`：将 Blob 结构化克隆给 Worker；不发送完整 `ArrayBuffer`，避免主线程额外读取及整文件复制。Worker 创建、消息传输、WASM 执行或流读取失败时，自动回退到原有 TypeScript 流式 `Sha256`。
- `frontend/src/App.tsx` 的文件内容哈希改为上述 Worker 路径；内存输入仍使用原有 `crypto.subtle.digest`。
- 服务端 CSP 增加 `script-src 'wasm-unsafe-eval'` 与 `worker-src 'self'`。这只允许 WebAssembly 编译和同源 Worker，未放开通用 `'unsafe-eval'`。

### 最佳实践依据

- [MDN: SubtleCrypto.digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)：`digest()` 不支持流式输入，必须传入完整的 `ArrayBuffer`、`TypedArray` 或 `DataView`。
- [W3C Web Crypto Level 2](https://w3c.github.io/webcrypto/)：标准签名为 `digest(AlgorithmIdentifier, BufferSource)`，没有 `ReadableStream` 形式的 digest API。
- [hash-wasm README](https://github.com/Daninet/hash-wasm)：提供 SHA-256 增量 API，并将 WASM 内嵌为 Base64，不依赖运行时下载独立 WASM 文件。
- [Vite Web Workers](https://vite.dev/guide/features.html#web-workers)：module Worker 使用 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`，与本实现和生产构建兼容。
- [MDN CSP script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)：WASM 编译需要精确的 `'wasm-unsafe-eval'` 指令。

### 实测结果

在本机 Chromium 148 无头模式、4 逻辑核环境中，用同一 Blob 与 Web Crypto SHA-256 比对结果：

| 文件大小 | `hash-wasm` Worker 流式 | 旧 TypeScript 流式回退 | 正确性 |
| --- | ---: | ---: | --- |
| 4 MiB | 10.8 MiB/s | 11.6 MiB/s | 两者均与 Web Crypto 一致 |
| 16 MiB | 25.1 MiB/s | 14.5 MiB/s | 两者均与 Web Crypto 一致 |
| 64 MiB | 28.1 MiB/s | 15.7 MiB/s | 两者均与 Web Crypto 一致 |

首个 4 MiB 请求会包含 Worker 启动和 WASM 初始化，因而不以它判断大文件吞吐。64 MiB 连续两次结果为 WASM `28.7/28.1 MiB/s`、旧实现 `15.9/15.7 MiB/s`，约为 1.8 倍。收益还包括将计算移出 UI 线程，并始终保持流式读取，不需要完整文件缓冲。

### 注意事项

- 不要引入未经维护或缺少测试向量的密码实现。
- WASM 实现必须与 Web Crypto 和当前 `Sha256` 使用随机数据、边界长度进行一致性测试。当前已覆盖 0、1、63、64、65、4096、65537 字节和超过 3 MiB 的输入。
- 内容哈希参与去重和缓存键，任何结果变化都会影响现有缓存命中和重复内容识别。
- 不能为了速度改成非密码哈希，除非重新评估碰撞对去重和业务语义的影响。
- TypeScript 回退优先保证兼容性，低性能设备上会占用主线程；因此应记录 Worker 降级次数，确认是否存在 CSP、浏览器兼容或 WASM 初始化问题。

### 预期收益

在本次 ARM 测试环境中，这是单项收益最大的 CPU 优化。64 MiB 哈希耗时有机会从约 14.5 秒降低到 1 至 3 秒量级，具体取决于 WASM 实现和设备。本机 Chromium 验证显示从约 4.1 秒降至约 2.3 秒，且页面主线程不再承担哈希计算。

## 4.2 P0：建立加密、缓存、上传流水线

### 当前问题

`encryptInputChunks` 必须先返回完整的 `CachedEncryptedChunk[]`，上传循环才会开始。这在优化前造成：

- 文件首个字节上传前必须等待完整哈希和完整加密。
- AES 运行时网络连接空闲。
- 上传运行时 AES 基本空闲。
- 内存中同时持有所有密文分片。
- 写完完整 IndexedDB 缓存后才开始网络阶段。

### 建议方案

在内容哈希完成后，使用一个有界任务队列：

```text
读取分片 -> AES-GCM 加密 -> 保存单个密文分片 -> 上传该分片
                    |                         |
                    +---- 保持少量待上传缓冲 --+
```

建议同时存在 2 至 3 个分片任务，但分别限制：

- 最大读取/加密并发。
- 最大上传并发。
- 内存中最大待上传字节数。

上传结果需要按分片序号写回最终索引，不能依赖请求完成顺序。

### 失败恢复

流水线必须保留当前缓存提供的重试能力：

- 每个分片加密完成后立即保存。
- 缓存记录每个分片的上传状态和远端 `blobId`。
- 重试时跳过已经上传成功的分片。
- 最终索引保存成功前，不删除恢复信息。
- 若部分上传后永久失败，应提供后台清理孤立 blob 的机制。

### 预期收益

当网络上传时间和加密时间接近时，流水线可将总耗时从两者相加降低到接近两者中的较大值。例如：

```text
当前：哈希时间 + 加密时间 + 缓存时间 + 上传时间
优化：哈希时间 + max(加密/缓存时间, 上传时间) + 少量收尾时间
```

### 已实施（2026-08-02）

- 大文件上传已改为有界的“读取/加密/缓存 -> 顺序上传”流水线。加密准备最多并行 `min(3, hardwareConcurrency - 1)` 个分片，上传仍按分片序号单路进行。
- 单路上传是有意保守选择：服务端当前每 IP 限流为每分钟 120 次，默认 4 MiB 分片的 512 MiB 文件已有 128 次上传请求。先重叠 CPU/磁盘与网络，避免未经服务端限流调整就增加并发上传导致稳定的 `429`。
- 有界队列把“正在加密、已加密待上传、正在上传”的合计分片数限制在准备并发上限内。以默认 4 MiB 分片和三路上限计算，密文工作集约为 12 MiB 加封装开销，而不是整个文件的密文副本。
- 缓存写入发生在单个分片加密后；上传失败时，已经加密的分片仍保留，可在下一次相同内容、组和分片大小的上传中复用。分片仍使用原始序号、`chunkSetId`、明文长度构成的 AAD，远端格式不变。
- 若分片准备或上传在中途失败，流水线会等待当前在途上传收敛，并尽力删除本次已成功上传但尚未写入索引的 blob；缓存密文保留以供重试。

## 4.3 P0：重构 IndexedDB 密文缓存

### 优化前问题

`frontend/src/blob_cache.ts` 在 v1 中将一个文件的所有密文分片保存在同一个对象中。

清理缓存时，`pruneEncryptedClipCache` 调用 `getAll()`，会把所有缓存记录及其中的密文读取和结构化克隆到内存，只是为了检查 `updatedAt` 并删除过期项。

项目允许单文件最大 512 MiB，缓存最多保留 8 个文件。理论上，这种清理方式可能触发数 GiB 的读取和克隆，实际浏览器通常会在达到此规模前出现明显停顿、缓存失败或内存压力。

### 建议数据模型

将数据库升级为两个或三个 object store：

```text
encryptedClips
  key, groupId, contentHash, size, chunkSize, chunkSetId, updatedAt, state

encryptedChunks
  [clipKey, chunkIndex], plainSize, encryptedSize, encrypted, uploadState, blobId

可选 encryptedCacheLRU
  updatedAt, clipKey
```

关键点：

- 淘汰逻辑只扫描元数据或 `updatedAt` 索引。
- 分片加密完成后逐个写入，不组装超大对象。
- 读取缓存时按分片序号使用 cursor 或单键读取。
- 删除文件缓存时，在一个事务中删除其所有分片。
- 数据库迁移失败时允许安全清空旧缓存，因为缓存不是唯一数据源。

### 预期收益

- 降低大文件加密后的卡顿。
- 降低浏览器内存峰值和 OOM 风险。
- 为流水线上传和断点恢复提供基础。
- 避免每次缓存写入后读取其他文件的全部密文。

### 已实施（2026-08-02）

- IndexedDB schema 已升级到 v2：`encryptedClips` 仅保存文件级元数据，`encryptedClipChunks` 以 `[cacheKey, chunkIndex]` 保存单个密文分片。
- 旧 v1 的单对象缓存会在升级时删除。缓存并非唯一数据源，安全丢弃旧缓存比迁移/克隆数百 MiB 密文更可靠。
- 淘汰逻辑只读取 `encryptedClips` 元数据，不再通过 `getAll()` 将其他缓存文件的密文载入内存。删除元数据时用索引遍历并删除该文件的分片。

## 4.4 P1：调整分片大小和并发策略

### 当前问题

- 客户端默认分片为 4 MiB：`frontend/src/App.tsx:85`。
- 服务端即使允许 50 MiB blob，也会将推荐明文分片限制在最多 4 MiB：`internal/server/server.go:118`。
- 最大文件为 512 MiB，因此可能产生 128 个数据分片。
- 服务端全局限流为每 IP 每分钟 120 次：`internal/server/server.go:78`。

除了 128 个上传请求，保存索引、读取索引和其他同步操作也会消耗限流配额。高速网络环境下，一个最大文件有可能仅靠分片上传就触发 `429 Too Many Requests`。

### 建议方案

初步将桌面端默认分片调整为 8 至 16 MiB，并满足：

```text
plainChunkSize + AES-GCM 封装开销 <= maxBlobBytes
```

移动端可以保守使用 4 至 8 MiB。选择依据包括：

- `navigator.deviceMemory`，仅在浏览器提供时使用。
- `navigator.hardwareConcurrency`。
- 文件总大小。
- 前几个分片的加密耗时和上传耗时。
- 服务端 `maxBlobBytes`。

并发策略不应只用 CPU 核数推导。可以先使用保守值 2，再根据首批分片测量决定是否提高到 3。

### 分片大小权衡

分片更大：

- 请求、签名、鉴权和 OpenList API 往返更少。
- AES 单次调用效率通常更高。
- 单个失败分片的重试成本更高。
- 峰值内存更高。

分片更小：

- 更适合低内存设备和细粒度重试。
- 请求数量、固定延迟和索引体积更大。

因此，不建议简单把分片直接提高到 50 MiB 上限。

## 4.5 P1：减少服务端重复读取组元数据

### 当前问题

每个已签名请求都会执行 `store.ReadGroup`，然后解析组公钥：`internal/server/server.go:458`。

OpenList 存储实现读取组信息至少涉及：

1. `/api/fs/get` 查询文件信息。
2. 请求 `raw_url` 下载 `group.json`。

大文件每个分片上传和下载都会重复该过程。128 个分片可能额外产生约 256 个 OpenList 请求，而且这些请求位于真正 blob 操作之前。

### 建议方案

在服务端增加有界 TTL 缓存，缓存：

- 规范化后的组元数据。
- 已解析的 `ecdsa.PublicKey`。
- 缓存版本或更新时间。

建议限制：

- TTL 1 至 5 分钟。
- 最大条目数，例如 1,000 或根据部署规模配置。
- 创建或更新组时主动失效对应缓存。
- 不缓存“未找到”过长时间，防止新建组短期不可见。

项目当前没有修改组公钥的常规接口，因此短 TTL 缓存风险较低，但仍需保持失效逻辑明确。

### 预期收益

在 OpenList 与网关网络延迟较高时，这项优化可能比服务端 CPU 优化更明显，同时减轻 OpenList API 压力。

## 4.6 P1：缓存已经创建的 blob 目录

### 当前问题

每次 `WriteBlob` 都调用 `mkdir` 创建对应月份目录：

- `internal/openlist/client.go:170`
- `internal/openlist/client.go:272`

即使目录已经存在，也会产生一次 OpenList API 往返，并依赖错误文本包含 `exist` 来判断成功。

### 建议方案

- 在进程内记录已经确认存在的目录。
- 每个目录使用 `singleflight` 或互斥，避免并发首次上传重复创建。
- `putFile` 因目录不存在而失败时，清除缓存、重新创建并重试一次。
- 如果 OpenList 提供原子“创建父目录”或更合适的接口，优先使用结构化返回码，不依赖错误文本。

按月份组织目录意味着活跃实例通常只需缓存少量路径。

## 4.7 P1：重新评估服务端临时文件路径

### 当前问题

超过 1 MiB 的已签名请求由 `readSignedBody` 执行：

```text
浏览器上传 -> 服务端边哈希边写临时文件 -> Seek 回文件开头 -> 上传 OpenList
```

相关代码位于 `internal/server/server.go:603` 至 `internal/server/server.go:641`。

这是由当前签名协议决定的：服务端只有接收完整请求体并验证其 SHA-256 后，才能确认签名有效；验证前不能安全地把未经认证的数据永久写入目标存储。

### 可直接实施的优化

- 将内存暂存阈值做成配置项，并根据容器内存调整。
- 对 4 至 16 MiB 分片，在内存充足的部署中使用内存暂存，减少临时文件写入和回读。
- 临时目录使用快速本地盘或受控 tmpfs，同时限制并发和总暂存字节数。
- 增加临时文件读写耗时和字节数指标。

### 高风险协议优化

若要真正做到浏览器到 OpenList 的一次流式传输，需要调整认证协议，例如：

- 客户端先提交已签名的密文摘要、长度和上传意图。
- 服务端验证预授权后接收并流式转发正文。
- 服务端流式计算摘要，结束后比对预授权摘要。
- 摘要不匹配时删除或隔离临时对象。

该方案涉及重放保护、未完成上传、孤立对象、配额滥用和原子提交，必须单独做安全设计，不能只删除当前服务端哈希步骤。

## 4.8 P2：优化下载内存和输出方式

### 当前问题

`plainBytes` 会等待全部分片下载和解密，再调用 `concatBytes` 复制成完整明文。对 512 MiB 文件，可能同时存在：

- 各个解密分片约 512 MiB。
- 拼接后的明文约 512 MiB。
- 少量仍未释放的密文和浏览器内部缓冲。

这在内存较小的移动设备上风险较高。

### 建议方案

按使用场景拆分：

- 图片预览、剪贴板复制：仍返回完整 `Uint8Array`，因为下游 API 通常需要完整 Blob。
- 文件下载：优先使用 File System Access API，按分片顺序解密并写入文件。
- 不支持 File System Access API 时，保留当前 Blob 下载回退。

由于分片可以并发完成但文件必须顺序写入，需要一个小型重排缓冲区，仅保存已完成但尚未轮到写出的分片。

## 4.9 P2：减少 Worker 和缓冲区复制

### 当前问题

目前已经使用 Transferable 传输分片，这是正确方向，但仍存在一些局部成本：

- Worker 第一次返回结果前，`workerReady` 为 `false`，初始请求会复制输入以保留回退能力。
- 每个请求都会结构化克隆 `CryptoKey`。
- `encryptEnvelope` 为魔数、nonce 和密文重新分配并复制完整输出。
- `decryptEnvelope` 使用 `slice` 复制 nonce 和密文。
- Worker 只有一个实例，多次 Web Crypto 调用是否真正并行取决于浏览器实现。

### 建议方案

- 增加 Worker 初始化握手，确认 `CryptoKey` 可克隆后再开始大文件任务。
- 在 Worker 中按组缓存 `CryptoKey`，请求只传递短 key id。
- 测试直接把 typed-array view 作为 Web Crypto `BufferSource`，减少显式切片和 `ArrayBuffer` 转换。
- 不要直接增加多个 Worker；先用实际设备基准判断浏览器 Web Crypto 是否已经利用内部线程池。
- 用 Performance API 记录分片排队、传输、Web Crypto 和回传时间。

这些优化通常小于哈希、流水线和缓存重构，应放在后续阶段。

## 4.10 P2：避免重复计算上传请求 SHA-256

### 当前问题

客户端完成密文加密后，`frontend/src/api.ts:224` 的请求签名又会对完整密文执行 SHA-256。服务端接收请求时也会再次计算相同摘要，用于验证签名。

服务端计算不可直接省略，否则无法确认收到的正文与客户端签名一致。客户端侧可以考虑在密文生成时记录摘要，但 Web Crypto AES-GCM 不会同时返回 SHA-256，仍然需要另一次扫描，除非：

- 使用流式/WASM 哈希处理已经生成的密文。
- 调整请求签名协议，让上传函数接收并复用预计算摘要。

### 建议

先测量这一阶段占比。原生 SHA-256 在测试设备上约 42 MiB/s，明显快于当前 AES 和纯 TypeScript 明文哈希，因此它不是第一优先级。

任何签名字段调整都会影响前后端兼容和安全协议，应版本化处理。

## 5. 不建议优先进行的改动

### 5.0 关于“全部采用流式方案”的边界

推荐把文件处理链路全部改成有界分片流水线，但不推荐用第三方算法替换现有 AES-GCM：

- Web Crypto 的 AES-GCM 仍接收单次 `BufferSource`，没有标准的 `ReadableStream` 加密接口。
- 项目现有 `aes-gcm-chunked-v1` 已将大文件拆成独立认证的分片，每片使用随机 nonce，并通过 AAD 绑定 `chunkSetId`、分片序号和明文长度。这是适合浏览器的流式文件加密结构。
- 本次优化改变的是读取、缓存和上传调度：任何时刻只处理少量分片，并让加密与上传重叠；它不改变 AES-GCM 算法、密文封装或远端索引格式。
- 旧 `aes-gcm-v1` 单体数据和既有 `aes-gcm-chunked-v1` 数据继续由原逻辑解密。Worker 不可用时，加解密仍回退到主线程 Web Crypto；WASM 只用于标准 Web Crypto 无法流式完成的文件 SHA-256。

官方依据：

- [MDN: SubtleCrypto.encrypt](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)：输入数据类型是完整的 `ArrayBuffer`、`TypedArray` 或 `DataView`，并明确推荐使用带认证的 GCM。
- [MDN: AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)：同一密钥下每次加密的 IV 必须唯一，推荐 96 位；`additionalData` 会被认证，解密时必须完全一致。

### 5.1 不建议直接替换 AES-GCM

原因：

- 当前格式已经稳定，并带有随机 96 位 nonce 和 GCM 认证标签。
- Web Crypto 通常调用浏览器原生密码库，可能利用硬件指令。
- 改成 ChaCha20-Poly1305、WASM AES 或自研流式 AEAD 会引入新格式和迁移成本。
- JavaScript/WASM 实现未必比设备上的 Web Crypto 更快。
- 密码实现错误的风险远高于普通性能优化。

只有在多类真实目标设备上确认 AES-GCM 是最终主瓶颈，并且有成熟、受审计实现和格式迁移方案时，才应重新评估算法。

### 5.2 不建议取消 AAD 或认证标签

分片 AAD 绑定：

- 加密格式版本。
- `chunkSetId`。
- 分片序号。
- 明文长度。

它可以防止分片跨文件替换、重排和截断。AAD 很短，性能成本可以忽略，不应为了速度移除。

### 5.3 不建议盲目提高并发

并发会增加：

- 内存峰值。
- Worker 和浏览器线程池调度成本。
- IndexedDB 压力。
- 网络请求数和服务端临时文件数。

本次实测中三路 16 MiB AES 没有优于两路，因此应采用测量驱动或保守自适应策略。

## 6. 推荐实施计划

### 阶段一：建立可重复基准

先增加开发环境性能记录，不改变协议：

- 明文哈希耗时和吞吐。
- 文件读取耗时。
- AES 加密/解密耗时。
- Worker 排队和传输耗时。
- IndexedDB 读、写、清理耗时。
- 请求摘要和 ECDSA 签名耗时。
- 每个分片上传/下载耗时。
- 服务端临时文件、鉴权和 OpenList 请求耗时。

至少测试：

- 4 MiB、64 MiB、256 MiB 和 512 MiB 文件。
- ARM 低功耗设备、普通桌面、Android 和 iOS Safari/PWA。
- 快速局域网和高延迟公网 OpenList。

### 阶段二：处理明确的 CPU 瓶颈（已完成）

1. 已引入受维护的 `hash-wasm` 流式 SHA-256。
2. 已添加 module Worker 哈希路径。
3. 已保留 TypeScript 回退。
4. 已添加边界长度和大 Blob 一致性测试。

这一阶段不改变远端数据格式，风险相对可控。下一步应在目标移动设备上记录 Worker 回退率和 64/256/512 MiB 吞吐。

### 阶段三：重构缓存和上传流水线（部分完成）

1. 已升级 IndexedDB schema。
2. 已分离文件元数据和密文分片。
3. 已实现逐分片持久化。
4. 已实现有界加密/顺序上传队列。
5. 尚未实现上传状态持久化、跨会话断点续传和孤立 blob 清理。

当前实现保持现有请求数与远端格式，先降低上传启动等待和内存峰值。完整断点续传需要缓存每片 `blobId` 与上传状态，并为索引提交失败后的孤立 blob 设计回收策略，应作为独立可靠性改动处理。

### 阶段四：减少固定网络往返

1. 将分片调整到 8 至 16 MiB，并保留移动端保守策略。
2. 区分 API 元数据请求和数据分片请求的限流策略。
3. 服务端缓存组元数据和解析后的公钥。
4. 缓存已创建的 OpenList 月份目录。

### 阶段五：按场景优化下载

1. 文件下载增加流式写盘路径。
2. 图片和剪贴板路径保留完整内存结果。
3. 处理取消、磁盘写入失败和部分文件清理。

## 7. 验收指标建议

每个优化 PR 应提供优化前后同设备、同文件、同网络条件的数据。

建议指标：

| 指标 | 建议目标 |
| --- | --- |
| 64 MiB 文件明文哈希 | 至少比当前 TypeScript 实现快 3 倍 |
| 首个上传请求启动时间 | 不再等待全部分片加密完成 |
| 上传峰值 JS 内存 | 与文件总大小基本解耦，主要由队列字节上限决定 |
| IndexedDB 淘汰 | 不读取非目标文件的密文数据 |
| 512 MiB 文件请求数 | 默认配置下明显少于 128 个 |
| 最大文件上传 | 不因默认限流稳定触发 429 |
| 数据兼容性 | 旧 `aes-gcm-v1` 和 `aes-gcm-chunked-v1` 均可继续解密 |
| 完整性保护 | AAD 修改、分片重排、密文损坏均必须失败 |

同时应记录 P50、P95，而不只记录一次最快结果。

## 8. 测试要求

### 密码正确性

- 新旧格式往返测试。
- 不同分片大小测试。
- 0、1、15、16、17 字节以及分片边界长度测试。
- AAD、nonce、密文和认证标签被修改时必须失败。
- WASM、TypeScript 和 Web Crypto SHA-256 结果一致。

### 缓存和恢复

- 加密中刷新页面。
- 上传中断网并恢复。
- 部分分片已上传后重试。
- IndexedDB 配额耗尽。
- 数据库升级失败或旧缓存损坏。
- 多标签页同时处理相同文件。

### 性能和资源

- 最大文件峰值内存。
- 长任务和界面卡顿。
- Worker 意外终止后的回退行为。
- 低存储空间下的临时文件和 IndexedDB 行为。
- 多用户并发上传时服务端临时文件总量。

## 9. 分析验证状态

本次分析期间：

- 前端 Vitest：3 个测试文件、18 个测试全部通过。
- 前端 TypeScript 检查和 Vite 生产构建通过。
- 在真实 Chromium 148 中验证 WASM Worker、旧 TypeScript 回退与 Web Crypto 的 SHA-256 结果一致；64 MiB 流式 Worker 吞吐约为旧实现的 1.8 倍。
- 在真实 Chromium 148 中验证 IndexedDB v1 到 v2 升级、两分片写入/读取和级联删除；旧大对象表被安全移除，删除后元数据和分片计数均为 0。
- 当前机器未安装 Go 工具链，因此未运行服务端 Go 测试。
- 基准使用独立临时页面执行，没有修改项目运行逻辑。

本文给出的吞吐数据适合确定优化优先级。正式实施时，应先加入项目内可重复运行的基准，再用目标用户设备验证最终参数。
