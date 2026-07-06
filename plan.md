# Safari iOS 后台推送与加解密性能优化计划

## Summary

- iOS/iPadOS Web Push 从 iOS 16.4 起支持，但仅对“添加到主屏幕”的 Web App 生效；普通 Safari 标签页不能接收后台 Web Push。
- 当前代码已正确识别 `iOS Safari + 非 standalone` 并降级，但可以增强安装引导、manifest 标识、订阅恢复、通知点击行为和 badge 支持。
- 当前加解密使用 Web Crypto AES-GCM，安全基础正确；性能瓶颈更可能来自主线程串行处理、ArrayBuffer/Uint8Array 拷贝、串行下载解密和 IndexedDB 大对象读写。
- 推荐第一阶段不改加密格式，保持 `aes-gcm-v1` 和现有 chunk AAD 兼容，只优化执行位置、并发和内存路径。

## Key Changes

- Safari iOS Web Push：
  - 保留现有 `isIOSSafari() && !isStandaloneWebApp()` 限制判断，并把 UI 文案改成更明确的操作提示：Safari 分享按钮 -> 添加到主屏幕 -> 从主屏幕重新打开 -> 再开启通知。
  - 检查并完善 `frontend/public/manifest.webmanifest`：确保有稳定 `id`、`display: "standalone"`、`start_url`、`scope`、合适图标和主题色。Apple/WebKit 文档强调 Home Screen web app 身份会影响通知和 Focus 同步。
  - 在主屏模式下注册 service worker 后，监听/检查订阅状态：如果 `getSubscription()` 为空但用户开关仍开启，自动重建订阅并同步服务器。
  - service worker 的 `push` 处理继续使用 `showNotification()`，但补充更稳健的 payload 解析、`data.url` 指向当前 group 路径或首页可恢复状态，点击时优先 focus 同源窗口。
  - 可选增加 Badging API：收到远端更新时 `navigator.setAppBadge(1)`，用户打开/同步后 `clearAppBadge()`；仅在支持且通知权限允许时调用。
  - 不实现 silent push 或后台数据同步；iOS Web Push 不适合作为静默后台同步机制，通知必须用户可见。

- 加解密性能：
  - 新增 dedicated crypto worker，把大文件 chunk 的 `encryptChunkBytes`、`decryptChunkBytes` 和可选 SHA-256 计算从主线程移出；主线程只负责进度、上传/下载调度和 UI 状态。
  - 保持现有 AES-GCM envelope 格式：`magic + 12-byte nonce + ciphertext/tag`，继续使用每 chunk 独立随机 nonce 和现有 AAD，不做格式迁移。
  - 使用可配置并发窗口处理大文件 chunk，例如默认 `2` 或 `navigator.hardwareConcurrency - 1` 上限内的保守值；避免一次性并发过高导致 iOS Safari 内存压力。
  - 下载解密改成“有限并发下载 + worker 解密 + 按 index 合并”，替代当前逐块串行下载/解密。
  - 减少拷贝：优先传递 `ArrayBuffer` 给 worker，使用 transferable `postMessage(..., [buffer])`；避免不必要的 `slice()`，在安全可控处使用 `subarray()` 或直接传递底层 buffer。
  - 保留 IndexedDB 密文分片缓存，但避免把所有大文件 chunk 同时长期留在内存；上传完成后释放临时引用，解密预览时按需合并。

- 安全和兼容：
  - 不复用 AES-GCM nonce；不把多个 chunk 强行改成同一个 nonce 的“流式”消息。
  - 不切换到非认证模式如 AES-CTR/CBC；性能优化只围绕 Web Crypto、worker、并发和内存。
  - 对不支持 worker Web Crypto 或 transferable 异常的浏览器，回退到当前主线程路径。

## Test Plan

- iOS Safari / PWA：
  - 普通 Safari 标签页显示“添加到主屏幕后可开启后台通知”，不请求通知权限。
  - 添加到主屏幕后打开，通知权限请求必须由用户点击触发；授权后可创建 Push Subscription 并保存到服务端。
  - 关闭页面后发送 Web Push，iOS 锁屏/通知中心能显示通知；点击通知能打开或聚焦应用。
  - 取消通知开关后，客户端 unsubscribe，并调用服务端删除订阅。
  - 订阅丢失或过期时，重新开启通知能自动重建订阅。

- 加解密：
  - 现有 `crypto.test.ts` 全部通过，旧 `aes-gcm-v1` envelope 可读。
  - 小文本、小图片、大文件、分片文件均能加密上传、下载解密、预览/复制。
  - 故意篡改 chunk AAD、nonce 或密文，解密失败路径保持明确错误。
  - 对比优化前后：大文件上传加密耗时、下载解密耗时、主线程卡顿、峰值内存。
  - 在 Chrome/Edge、桌面 Safari、iOS Safari 主屏 Web App 上验证 fallback 和 worker 路径。

## Sources Checked

- Apple Developer: Sending web push notifications in web apps and browsers
  `https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers`
- WebKit: Web Push for Web Apps on iOS and iPadOS
  `https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/`
- WebKit: Meet Declarative Web Push
  `https://webkit.org/blog/16535/meet-declarative-web-push/`
- MDN: Web Crypto API
  `https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API`
- MDN: SubtleCrypto encrypt / AesGcmParams
  `https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt`
  `https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams`

## Assumptions

- 目标是优化当前 Web App，不引入原生 iOS App 或 APNs 原生客户端。
- 加密格式需要向后兼容，不做破坏性迁移。
- 第一阶段优先提升大文件体验和 iOS 通知可用性，不实现 Safari 18.4+ Declarative Web Push 的专用路径；该能力可作为后续增强。
