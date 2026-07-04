# OpenList Clipboard

基于 OpenList 存储的端到端加密在线剪贴板。一个剪贴板密钥对应一个剪贴板，服务端只保存剪贴板名称、密钥校验哈希和签名公钥，并代理 OpenList 存取密文。

## 功能

- 多剪贴板隔离：每个剪贴板有独立剪贴板密钥、签名身份、索引和 blob 路径。
- AES-GCM 客户端加密，OpenList 和网关不接触明文。
- 创建剪贴板需要 `CLIPBOARD_CREATE_PASSWORD`；加入剪贴板只需要 `olckey1...` 剪贴板密钥。
- 页面内容实时更新：同一后端实例下的同剪贴板设备写入后，其他已打开页面通过 SSE 刷新列表，不使用轮询。
- 可选前台剪贴板同步：页面在前台时可在窗口聚焦、重新可见、收到实时更新或浏览器支持的剪贴板变化事件后同步系统剪贴板。
- 可选后台通知：配置 VAPID 后，浏览器关闭时也可通过 Web Push 收到泛化更新提醒。
- SolidJS/Vite 前端，支持文本、图片、小文件的粘贴、拖拽、复制、下载和本地预览。

## 配置

复制 `.env.example` 为 `.env`，然后先改掉所有 `change-this...` 示例值。服务启动时会自动读取当前目录下的 `.env`。

### 应用参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CLIPBOARD_ADDR` | 否 | `:8080` | 后端监听地址。Docker 镜像内部固定监听 `:8080`。 |
| `CLIPBOARD_ALLOWED_ORIGIN` | 否 | 空 | 只在前端和 API 跨来源访问时需要填写，值必须是浏览器实际访问来源。前端由本服务直接托管时可以留空。 |
| `CLIPBOARD_CREATE_PASSWORD` | 是 | 无 | 创建新剪贴板时输入的管理口令。必须换成强随机值，不能使用示例值。 |
| `CLIPBOARD_MAX_BLOB_BYTES` | 否 | `52428800` | 单个密文 blob 最大字节数。前端会按该值计算分片大小。 |
| `CLIPBOARD_TRUST_PROXY_HEADERS` | 否 | `false` | 是否信任 `X-Forwarded-For` 作为客户端 IP。只在前面有可信反向代理时设置为 `true`。 |
| `CLIPBOARD_STATIC_DIR` | 否 | `frontend/dist` | 本地直接运行 Go 服务时的前端静态文件目录。Docker 镜像已内置 `/app/frontend/dist`，通常不要在 `.env` 中启用它。 |

### OpenList 参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `OPENLIST_BASE_URL` | 是 | 无 | 已有 OpenList 的访问地址，例如 `http://127.0.0.1:5244`、`http://host.docker.internal:5244` 或同一 Docker 网络中的服务名地址。末尾斜杠会被自动去掉。 |
| `OPENLIST_USERNAME` | 是 | 无 | OpenList 用户名。建议为剪贴板单独创建服务账号。 |
| `OPENLIST_PASSWORD` | 是 | 无 | OpenList 密码。必须换成真实密码，不能使用示例值。 |
| `OPENLIST_OTP_CODE` | 否 | 空 | OpenList 登录需要二次验证码时填写。服务会缓存登录 token，重启后如果验证码过期需要更新。 |
| `OPENLIST_ROOT` | 否 | `/clipboard` | 存放剪贴板数据的 OpenList 虚拟路径。它是 OpenList 内部路径，不是宿主机目录，也不是 Docker volume。 |
| `OPENLIST_CLIENT_ID` | 否 | `openlist-clipboard-gateway` | 调用 OpenList API 时发送的客户端 ID。通常保持默认。 |

### 通知参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CLIPBOARD_VAPID_PUBLIC_KEY` | 否 | 空 | Web Push 公钥。 |
| `CLIPBOARD_VAPID_PRIVATE_KEY` | 否 | 空 | Web Push 私钥。 |
| `CLIPBOARD_VAPID_SUBJECT` | 否 | 空 | Web Push subject，例如 `mailto:admin@example.com`。 |

三项 VAPID 参数必须同时填写才会启用 Web Push。生成命令：

```sh
go run ./cmd/server --generate-vapid
```

未配置 VAPID 时，“通知”开关仍可在页面打开时使用系统通知或页内提示，但浏览器关闭后不会收到 Web Push。推送通知只包含“剪贴板内容已更新”这类泛化提示，不包含明文内容、文件名或预览。

## 接入已有 OpenList

本项目不会启动或管理 OpenList，只通过 OpenList API 读写密文文件。接入已有 OpenList 时按下面整理：

1. 在 OpenList 中准备一个已有挂载空间下的目录，例如 `/clipboard`、`/data/clipboard` 或 `/nas/apps/clipboard`。这里的路径是 OpenList 页面里看到的虚拟路径。
2. 建议创建单独用户，例如 `clipboard`，并把读、写、创建目录、删除文件权限限制在该目录范围内。
3. 把 `OPENLIST_ROOT` 设置为上面的虚拟路径。首次启动时服务会确保 `{OPENLIST_ROOT}/v1/groups` 等目录存在。
4. 确认本应用容器能访问 `OPENLIST_BASE_URL`：OpenList 在宿主机上时常用 `http://host.docker.internal:5244`；OpenList 和本应用在同一个 Compose 网络里时使用服务名，例如 `http://openlist:5244`；OpenList 在另一台机器上时使用那台机器的内网地址。
5. 启动后检查 `GET /api/health`，再创建第一个剪贴板。

不要把宿主机目录挂载到 `openlist-clipboard` 容器来存数据。所有剪贴板数据都应写入 OpenList 的已有挂载空间，由 OpenList 负责底层存储。

生成的 OpenList 路径形如：

```text
{OPENLIST_ROOT}/v1/groups/{groupId}/group.json
{OPENLIST_ROOT}/v1/groups/{groupId}/index.enc
{OPENLIST_ROOT}/v1/groups/{groupId}/push-subscriptions.json
{OPENLIST_ROOT}/v1/groups/{groupId}/blobs/YYYY-MM/{clipId}.bin
```

## 本地运行

要求：

- Go 1.26 或更新版本。
- Node.js `^20.19.0 || >=22.12.0`。前端使用 Vite 8，低于此范围的 Node 版本会在安装或构建时报 engine 错误。

1. 复制 `.env.example` 为 `.env`，修改创建口令和 OpenList 连接信息。
2. 安装前端依赖并构建静态文件：

   ```sh
   cd frontend
   npm install
   npm run build
   ```

3. 启动后端：

   ```sh
   go run ./cmd/server
   ```

4. 打开 `http://localhost:8080`，创建第一个剪贴板或用剪贴板密钥加入已有剪贴板。

开发前端时可运行 `npm run dev`，Vite 会把 `/api` 代理到 `http://127.0.0.1:8080`。

## Docker

Dockerfile 使用 Node 26 构建前端、Go 1.26 构建后端，并把构建后的静态文件打进最终镜像。镜像只包含本应用，不包含 OpenList。

```sh
docker build -t openlist-clipboard:local .
docker run --rm -p 8080:8080 --env-file .env openlist-clipboard:local
```

使用 compose 示例：

```sh
cp compose.example.yml compose.yml
docker compose --env-file .env -f compose.yml up -d --build
```

Compose 默认把本应用发布到宿主机 `8080` 端口。OpenList 在宿主机运行时，示例里的 `host.docker.internal` 会通过 `extra_hosts` 映射到宿主机网关；如果你的 Docker 环境不支持该映射，请把 `OPENLIST_BASE_URL` 改成容器可访问的实际地址。

## 前台剪贴板同步

- “同步”开关按本机剪贴板保存，开启后只在页面可见且窗口处于前台时运行。
- 浏览器不会提供可靠的系统剪贴板修改时间；应用只能使用“本次观察到剪贴板变化的时间”与页面最新剪贴内容时间做近似判断。
- 同步优先支持文本；图片在支持 `ClipboardItem` 的浏览器中可自动写入，普通文件不能跨浏览器自动写入系统剪贴板。
- 实时列表刷新仍使用 SSE，不使用轮询；后台或未聚焦窗口中的剪贴板读写可能被浏览器拒绝。
- 网络断开、OpenList 临时 `5xx` 或限流 `429` 会保持实时连接重试；远端剪贴板不存在、签名失败或密钥失效时会停止重连。
- 停止重连不会自动删除本机保存的剪贴板密钥。用户可以手动刷新重试、切换剪贴板、忘记本机记录或重新加入。

## 剪贴板密钥

- 首台设备点击“创建剪贴板”会生成剪贴板密钥，并从该密钥确定性派生剪贴板 ID、密钥校验哈希和 ECDSA P-256 签名身份。
- 剪贴板密钥格式为 `olckey1.<base64url-key>`，是加入剪贴板的唯一凭据。
- 已打开剪贴板可生成二维码，其他设备扫码或粘贴密钥后加入同一剪贴板，并从服务器读取剪贴板名称。
- 服务端保存剪贴板名称、签名公钥和密钥校验哈希，不保存剪贴板密钥或签名私钥。
- 大文件会按分片在浏览器端加密，并在本机 IndexedDB 缓存密文分片；缓存不保存明文。

## 安全边界

- 服务端只接收密文 blob、随机 ID、大小、hash 和组公钥。
- 原始文件名、文本内容、MIME 类型、过期时间都只存在于加密索引里。
- 过期清理由已解锁的前端执行；服务端负责限制大小、路径、签名和请求频率。
