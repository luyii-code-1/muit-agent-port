# Multi-Agent Port

一个轻量的 Codex 跨电脑协作端口。它让本机 Codex 通过 MCP Tool Call 通知另一台电脑上的指定 Codex 对话，在双方确认接口现状后并行工作，并把结果返回给发起方。

典型场景：Mac 上的 Codex 修改 ESP32 固件时，通知 Windows 上负责 Android App 的 Codex 同步修改 BLE、JSON 或网络协议。

它由两部分组成：

- **Relay**：部署在所有电脑都能访问的位置，提供 Streamable HTTP MCP、WebSocket 路由和 SQLite 离线队列。
- **Bridge**：每台 Codex 电脑运行一个。它主动连出 Relay，并通过本机 `codex app-server` 查找、续接或创建 Codex 对话。

```text
Codex A -- MCP /mcp --> Relay <-- WSS /bridge -- Bridge B -- stdio --> codex app-server B
                         |                                  |
                         +-- SQLite queue                   +-- 指定/自动选择对话
```

## 已实现

- `codex_mesh_nodes`：发现在线/离线电脑及标签。
- `codex_mesh_projects`：列出节点扫描到的全部 Codex 项目目录和关联对话数。
- `codex_mesh_threads`：检索某台电脑缓存的 Codex 对话。
- `codex_mesh_delegate`：第一阶段只与另一台 Codex 讨论现状、风险、冲突、问题和计划，禁止修改文件。
- `codex_mesh_confirm`：阅读对面评估、解决问题后，确认在同一对话执行任务。
- 路由支持：
  - `exact`：继续指定 `thread_id`；
  - `best`：按 `cwd`、`thread_query`、空闲状态和活跃时间选择；无合适对话时新建；
  - `new`：始终创建新对话。
- `codex_mesh_task`：查询或短暂等待远程结果。
- 对已有任务的委派优先通过 Codex Desktop 本机 IPC 附着到原任务，由 Desktop 自身启动 turn。
- Relay 网页通过 SSE 显示实时状态、可公开的 Thinking 摘要、工具调用、命令和文件修改过程。
- `codex_mesh_activity`：通过 Tool Call 查看最近的 Codex 间协作提示和结果。
- `codex_mesh_pairing_code`：通过 Tool Call 生成 6 位一次性节点配对码。
- Relay 首页提供轻量控制台，显示电脑、Codex 对话标题、任务提示、状态和返回结果。
- 目标电脑离线时持久排队，重连后投递。
- Relay Bearer Token、每节点独立 Token、目录白名单和本地任务账本。
- Bridge 重启后不会自动重复执行中断任务，避免重复修改代码；中断任务会返回失败，可由发起方明确重新委派。

## 要求

- Node.js 20+
- 每台 Bridge 电脑已安装并登录 Codex CLI，且 `codex app-server` 可运行
- 生产网络中为 Relay 配置 HTTPS/WSS（Caddy、Nginx、Cloudflare Tunnel 或私有组网均可）

## 1. 安装

需要让 AI 在新电脑上完成安全部署、配对和验证时，使用 [`install.md`](install.md)。

```bash
npm install
npm run build
```

生成一个 Relay 管理 Token：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

它同时保护 MCP 和网页管理 API。各电脑的独立 Bridge Token 在一次性配对时自动生成，Relay 只保存哈希。不要把管理 Token 提交到 Git。

## 2. 启动 Relay

设置环境变量：

```bash
export MESH_HOST=127.0.0.1
export MESH_PORT=8787
export MESH_DB_PATH=./data/mesh.db
export MESH_MCP_TOKEN='<mcp-token>'
npm run start:relay
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

浏览器打开 Relay 根地址即可进入控制台，例如 `http://10.0.0.10:8787/`，登录密码就是 `MESH_MCP_TOKEN`。原生 Node 部署常驻内存较低，适合不希望运行 Docker 的小型主机。

若 Relay 暴露到公网，请让应用仍监听环回地址，由 TLS 反向代理公开 `/mcp` 和 `/bridge`。不要把明文 `ws://` 暴露到公网。

### Docker 启动 Relay

Docker 是可选方案。复制 `.env.example` 为 `.env`，至少填写 `MESH_MCP_TOKEN`，然后：

```bash
docker compose up -d --build
```

Compose 只运行中心 Relay；Bridge 必须运行在 Codex 所在宿主机上，才能访问该电脑的 Codex 登录态和对话。

## 3. 用一次性代码配对 Bridge

在网页点 **生成配对码**，或直接让任意已连接 Codex 调用 `codex_mesh_pairing_code`。然后在新电脑项目目录执行一条命令：

Mac 示例：

```bash
npm run pair:bridge -- \
  --relay ws://10.0.0.10:8787/bridge \
  --node macbook \
  --code 123456 \
  --cwd /Users/me/Development \
  --roots /Users/me/Development,/Users/me/Documents/Projects \
  --labels macos,frontend
```

Windows PowerShell 示例：

```powershell
npm run pair:bridge -- --relay ws://10.0.0.10:8787/bridge --node workstation --code 123456 --cwd D:\Projects --inbox D:\Projects\.codex-mesh\inbox --roots D:\Projects,E:\Research --labels windows,backend,gpu
```

配对码单次使用、默认 10 分钟失效。成功后 Bridge Token 会以 `0600` 权限保存到 `./data/bridge-credentials.json`，后续不再需要配对码。若 Relay 位于公网，把地址改成 `wss://`。

`MESH_ALLOWED_ROOTS` 是远程任务能进入的目录边界。建议列出具体项目根目录，不要设置为 `/`、用户主目录或整个磁盘。`MESH_INBOX_ROOT` 必须在白名单内，默认是 `<MESH_DEFAULT_CWD>/.codex-mesh/inbox`。Bridge 默认串行执行任务；确认任务会落在不同对话后，可用 `MESH_BRIDGE_CONCURRENCY` 提高并发。同一对话不应同时执行多个 turn。

## 4. 将 Relay 接入每台 Codex

在启动 Codex 的环境中设置 MCP Token：

```bash
export CODEX_MESH_TOKEN='<mcp-token>'
```

在 `~/.codex/config.toml`（全局）或可信项目的 `.codex/config.toml`（项目级）加入：

```toml
[mcp_servers.codex_mesh]
url = "https://mesh.example.com/mcp"
bearer_token_env_var = "CODEX_MESH_TOKEN"
tool_timeout_sec = 70
enabled = true
```

本机联调可将 URL 改为 `http://127.0.0.1:8787/mcp`。保存后重启 Codex；在 Codex 中输入 `/mcp` 检查连接。

也可在 Codex App 的 **Settings → MCP servers → Add server** 中选择 **Streamable HTTP** 添加同一地址。

## 5. 使用方式

可以直接对 Codex 说：

> 查看 mesh 上有哪些电脑，然后让 workstation 上最近的支付后端对话检查当前 API 设计，等 30 秒拿结果。

Codex 会组合调用：

1. `codex_mesh_nodes`
2. `codex_mesh_projects(node_id="workstation")`
3. `codex_mesh_threads(node_id="workstation", query="支付")`
4. `codex_mesh_delegate(routing="exact", thread_id="...", ...)`，只讨论并确认现状
5. 阅读对面回复，回答问题或处理冲突
6. `codex_mesh_confirm(consultation_task_id="...", confirmation="...")`，才进入执行
7. `codex_mesh_task(task_id="...", wait_seconds=30)`

让 Codex 说“显示最近的 Mesh 协作记录”会调用 `codex_mesh_activity`；说“给新电脑生成配对码”会调用 `codex_mesh_pairing_code`。

如果无需精确指定对话：

```json
{
  "target_node_id": "workstation",
  "routing": "best",
  "cwd": "D:\\Projects\\shop",
  "thread_query": "payments webhook",
  "prompt": "检查 webhook 的幂等性设计，并给出需要修改的文件和理由。",
  "wait_seconds": 30
}
```

## 路由规则

### Desktop 附着模式

当路由选中了已有任务（`exact` 或成功匹配的 `best`）时，Bridge 会连接本机 Codex Desktop IPC：macOS 为 `~/.codex/ipc/ipc.sock`，Windows 为 `\\.\pipe\codex-ipc`。Desktop 必须正在运行并能持有目标任务；否则任务会明确失败，不再静默切换到不可见的后台 turn。

`routing=new` 仍会在空白收件箱项目中创建后台 app-server 任务，因为它没有可附着的 Desktop 任务。网页会明确标记“后台”。Thinking 只显示 Codex 提供的推理摘要，不显示隐藏的内部推理原文。

- `exact` 只接受目标电脑真实存在的 `thread_id`，不存在就失败，不会静默投到其他对话。
- `best` 先严格匹配 `cwd`，再匹配 `thread_query` 的标题/首条消息关键词，然后参考空闲状态和最近更新时间。
- 当 `best` 没有满足约束的候选时，也会按新对话处理，在 Mesh inbox 下创建独立空项目；请求的 `cwd` 只用于寻找已有对话，不会成为新对话的工作目录。
- `new` 不读取历史上下文，并在接收端的 Mesh inbox 下为每次委派创建一个独立空项目。对话仍由本机 `codex app-server` 正常创建，因此会显示在 Codex Desktop App 的任务列表中。

对话清单由 Bridge 默认每 30 秒刷新一次，所以 MCP 侧看到的是缓存；实际执行前 Bridge 会再次读取本机对话。

Bridge 会分页读取未归档和已归档线程，并覆盖 CLI、VS Code、exec、app-server 和各类 sub-agent 来源，而不是只读取最近一页。项目扫描覆盖白名单根目录下的直接项目，以及 Codex 日期目录中的全部项目。

## 安全边界

- MCP Token 的持有者可以向任意已注册节点委派工作，应视作代码执行控制面凭据。
- 每台节点使用独立 Token；泄漏时只需轮换对应节点。
- 6 位配对码单次使用、短时有效，`/pair` 还带有按来源地址的尝试频率限制。
- Relay 不应直接终止 TLS；请放在 HTTPS/WSS 反向代理或可信私网后。
- 默认 `workspace-write + never` 适合无人值守协作：Agent 不能请求额外权限。若改成 `danger-full-access`，远程任务的影响范围会显著扩大。
- Relay 会在 SQLite 中保存任务提示和结果；不要在提示中放密码、密钥或个人敏感数据。
- Relay 会在对话索引入库和控制台/API 输出时脱敏 PEM 私钥、Bearer Token、密码和常见密钥字段；这不能替代源密钥轮换。
- `MESH_ALLOWED_ROOTS` 限制 `cwd`，但它不是操作系统级沙箱；真正的文件权限仍由 Codex sandbox 和宿主账户决定。
- 本实现只信任已认证节点，不尝试在不同人员/组织间建立多租户隔离。

## 运维

- Relay 数据：`MESH_DB_PATH`，使用 SQLite WAL；备份数据库文件和 `-wal` 文件，或先停服务再复制。
- Bridge 去重账本：`MESH_BRIDGE_DB_PATH`，默认 `./data/bridge-<node-id>.db`。
- 节点离线后任务保持 `queued/dispatched`，重连会再次投递；Bridge 本地账本阻止已完成任务重复运行。
- 当前版本没有远程取消正在执行的 turn；需要取消时，在目标电脑的 Codex 中停止对应任务。

## 开发验证

```bash
npm run check
npm test
npm run build
```

本项目在启动时不调用 OpenAI API；只有目标 Bridge 收到委派并发起 Codex turn 时，才会使用该电脑现有的 Codex 登录态。

## License

Copyright (C) 2026 Multi-Agent Port contributors.

本项目采用 [GNU General Public License v3.0](LICENSE) 发布。分发修改版本时必须遵守 GPL-3.0 的源代码公开和相同许可证要求。
