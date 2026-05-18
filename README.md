# OpenList Clipboard

基于 OpenList 存储的端到端加密在线剪贴板。浏览器生成分组邀请码，服务端只保存每组签名公钥并代理 OpenList 存取密文。

## 功能

- 多组设备隔离：每个组有独立 Vault Key、签名身份、索引和 blob 路径。
- AES-GCM 客户端加密，OpenList 和网关不接触明文。
- 无外层应用密码：设备通过 `olcgrp1...` 邀请码加入组，请求使用浏览器本地签名私钥逐次签名。
- 页面内容实时更新：同一后端实例下的同组设备写入后，其他已打开页面通过 SSE 刷新列表，不使用轮询。
- 可选前台剪贴板同步：页面在前台时可在窗口聚焦、重新可见、收到实时更新或浏览器支持的剪贴板变化事件后同步系统剪贴板。
- SolidJS/Vite 前端，支持文本、图片、小文件的粘贴、拖拽、复制、下载和本地预览。

## 运行

1. 复制 `.env.example` 为 `.env` 并修改 OpenList 连接信息。
2. 安装前端依赖并构建静态文件：

   ```powershell
   cd frontend
   npm install
   npm run build
   ```

3. 启动后端：

   ```powershell
   go run ./cmd/server
   ```

4. 打开 `http://localhost:8080`，创建第一个分组或导入邀请码。

开发前端时可运行 `npm run dev`，Vite 会把 `/api` 代理到 `http://127.0.0.1:8080`。

## Docker

```powershell
docker build -t openlist-clipboard:local .
docker run --rm -p 8080:8080 --env-file .env openlist-clipboard:local
```

使用 compose 示例：

```powershell
copy compose.example.yml compose.yml
docker compose --env-file .env -f compose.yml up -d --build
```

如果 OpenList 运行在宿主机，`OPENLIST_BASE_URL` 可使用 `http://host.docker.internal:5244`。如果 OpenList 和本应用在同一个 compose 网络里，把它改成对应服务名，例如 `http://openlist:5244`。

## HTTPS

浏览器的 Web Crypto、剪贴板和摄像头能力都要求 HTTPS 或 localhost。生产部署不要用 `http://服务器IP:8080` 访问。

有域名时可以使用 Caddy 示例：

```powershell
copy compose.https.example.yml compose.yml
docker compose --env-file .env -f compose.yml up -d --build
```

`.env` 中至少设置：

```env
CLIPBOARD_PUBLIC_URL=https://clipboard.example.com
CLIPBOARD_ALLOWED_ORIGIN=https://clipboard.example.com
```

## 前台剪贴板同步

- “同步”开关按本机分组保存，开启后只在页面可见且窗口处于前台时运行。
- 浏览器不会提供可靠的系统剪贴板修改时间；应用只能使用“本次观察到剪贴板变化的时间”与页面最新剪贴内容时间做近似判断。
- 同步优先支持文本；图片在支持 `ClipboardItem` 的浏览器中可自动写入，普通文件不能跨浏览器自动写入系统剪贴板。
- 实时列表刷新仍使用 SSE，不使用轮询；后台或未聚焦窗口中的剪贴板读写可能被浏览器拒绝。

## 分组邀请码

- 首台设备点击“创建组”会生成 Vault Key、ECDSA P-256 签名密钥和邀请码。
- 邀请码格式为 `olcgrp1.<base64url-json>`，包含该组完整访问权限。
- 已打开组可生成二维码，其他设备扫码或粘贴邀请码后加入同一组。
- 服务端只保存签名公钥，不保存 Vault Key 或签名私钥。

## 存储布局

- 新 V1 路径：`/clipboard/v1/groups/{groupId}/group.json`、`index.enc`、`blobs/YYYY-MM/{clipId}.bin`。
- 旧版 `/clipboard/v1/users/default` 不再读写，也不会自动删除；需要管理员手动清理。

## 安全边界

- 服务端只接收密文 blob、随机 ID、大小、hash 和组公钥。
- 原始文件名、文本内容、MIME 类型、过期时间都只存在于加密索引里。
- 过期清理由已解锁的前端执行；服务端负责限制大小、路径、签名和请求频率。
