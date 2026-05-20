# OpenList Clipboard

基于 OpenList 存储的端到端加密在线剪贴板。一个剪贴板密钥对应一个剪贴板，服务端只保存剪贴板名称、密钥校验哈希和签名公钥，并代理 OpenList 存取密文。

## 功能

- 多剪贴板隔离：每个剪贴板有独立剪贴板密钥、签名身份、索引和 blob 路径。
- AES-GCM 客户端加密，OpenList 和网关不接触明文。
- 创建剪贴板需要 `CLIPBOARD_CREATE_PASSWORD`；加入剪贴板只需要 `olckey1...` 剪贴板密钥。
- 页面内容实时更新：同一后端实例下的同剪贴板设备写入后，其他已打开页面通过 SSE 刷新列表，不使用轮询。
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

4. 打开 `http://localhost:8080`，创建第一个剪贴板或用剪贴板密钥加入已有剪贴板。

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
CLIPBOARD_CREATE_PASSWORD=change-this-create-password
```

## 前台剪贴板同步

- “同步”开关按本机剪贴板保存，开启后只在页面可见且窗口处于前台时运行。
- 浏览器不会提供可靠的系统剪贴板修改时间；应用只能使用“本次观察到剪贴板变化的时间”与页面最新剪贴内容时间做近似判断。
- 同步优先支持文本；图片在支持 `ClipboardItem` 的浏览器中可自动写入，普通文件不能跨浏览器自动写入系统剪贴板。
- 实时列表刷新仍使用 SSE，不使用轮询；后台或未聚焦窗口中的剪贴板读写可能被浏览器拒绝。

## 剪贴板密钥

- 首台设备点击“创建剪贴板”会生成剪贴板密钥，并从该密钥确定性派生剪贴板 ID、密钥校验哈希和 ECDSA P-256 签名身份。
- 剪贴板密钥格式为 `olckey1.<base64url-key>`，是加入剪贴板的唯一凭据。
- 已打开剪贴板可生成二维码，其他设备扫码或粘贴密钥后加入同一剪贴板，并从服务器读取剪贴板名称。
- 服务端保存剪贴板名称、签名公钥和密钥校验哈希，不保存剪贴板密钥或签名私钥。

## 存储布局

- 新 V1 路径：`/clipboard/v1/groups/{groupId}/group.json`、`index.enc`、`blobs/YYYY-MM/{clipId}.bin`。
- 旧版 `/clipboard/v1/users/default` 不再读写，也不会自动删除；需要管理员手动清理。

## 安全边界

- 服务端只接收密文 blob、随机 ID、大小、hash 和组公钥。
- 原始文件名、文本内容、MIME 类型、过期时间都只存在于加密索引里。
- 过期清理由已解锁的前端执行；服务端负责限制大小、路径、签名和请求频率。
