# Happier Anywhere

[English](README.md) · [Happier 上游仓库](https://github.com/happier-dev/happier) · [轻量部署仓库](https://github.com/ALTair289/Happier-Anywhere-Deploy)

Happier Anywhere 是一个面向多平台的源码与部署项目，让你不必一直守在原始终端前，也能使用手机、桌面客户端或浏览器管理正在运行的编程智能体。它可以把本机或 SSH 远端的 Codex、Claude Code 及其他受支持智能体接入 Happier，用于查看任务、发送指令、审批操作、中断或恢复运行，并在安全边界内接管已经存在的会话。

Happier Anywhere 基于 [Happier](https://github.com/happier-dev/happier) 构建。本仓库保留 Happier 的源码历史和 MIT 许可证，并在此基础上加入 Happier Anywhere 所需的部署、远端机器、会话所有权、发布和安全能力。来源与继承关系请查看 [NOTICE](NOTICE)、[UPSTREAM.md](UPSTREAM.md) 和 [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json)。

## 仓库分工

| 仓库 | 用途 |
| --- | --- |
| [Happier Anywhere](https://github.com/ALTair289/Happier-Anywhere) | 完整源码、测试、构建脚本、协议、CLI、服务端、客户端和部署流水线 |
| [Happier Anywhere Deploy](https://github.com/ALTair289/Happier-Anywhere-Deploy) | 轻量安装项目、发布清单、校验和、签名和运维文档 |
| [happier-dev/happier](https://github.com/happier-dev/happier) | Happier 上游项目及其客户端生态 |

## 它解决什么问题

- 使用 Happier 手机 App、桌面端或浏览器访问任务。
- 由一台控制端管理本机智能体，以及通过 SSH 连接的远端智能体。
- 覆盖 Windows x64、Linux x64/ARM64、macOS Intel/Apple Silicon。
- 发现真实会话，而不是只展示演示或模拟任务。
- 支持查看、发消息、审批、中断、恢复和受控接管。
- Relay 默认只监听回环地址，再通过 Tailscale Serve 等认证 HTTPS 网关私有开放。
- 提供可复现发布清单、校验和、Minisign 验证、来源记录和秘密扫描。

推荐拓扑如下：

```text
Happier App / Desktop / Web
            │ HTTPS
            ▼
私有网关（例如 Tailscale Serve）
            │
            ▼
Relay：127.0.0.1:3005
            │
         控制端 daemon
       ┌────┴───────────────┐
       ▼                    ▼
本机编程智能体          SSH 远端机器
                            │
                            ▼
                    Codex / Claude Code / 其他
```

## 当前状态

当前经过审查的集成候选位于 `integration` 分支。稳定部署应优先使用已经发布且签名完整的构件。在该分支合并前，从源码使用时应明确切换到它，不要默认认为 `dev` 已包含同样的改动。

## 从源码快速开始

### 前置条件

- Git。
- 与本仓库兼容、支持 Corepack 的较新 Node.js。
- 仓库通过 `packageManager` 固定的 Yarn 1.22.22。
- 至少一个受支持的智能体 CLI，例如 Codex 或 Claude Code。
- 远端控制需要 SSH。
- 可选：Docker 用于容器化 Relay，Tailscale 用于私有 HTTPS 入口。

### 克隆与构建

```bash
git clone https://github.com/ALTair289/Happier-Anywhere.git
cd Happier-Anywhere
git switch integration

corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
yarn build
```

集成分支合并后，应改用仓库默认开发分支。

### 启动引导式本地环境

```bash
yarn tui
```

TUI 是从源码体验和开发最方便的入口，可以集中查看本地服务端、CLI、客户端、认证和服务状态。

如果需要后台开发栈：

```bash
yarn dev
```

停止由仓库启动的后台进程：

```bash
yarn stop
```

### 激活并登录 CLI

```bash
yarn cli:activate
happier auth login
```

随后可以通过 Happier 启动智能体，例如：

```bash
happier codex
```

不同智能体可支持的功能有所差异。自动化之前请先查看 CLI 帮助：

```bash
happier --help
```

## 使用 Happier App、桌面端和 Web

Happier Anywhere 使用 Happier 的客户端体验。你可以从 [Happier 上游项目](https://github.com/happier-dev/happier)安装当前客户端，也可以直接从本源码运行对应界面：

```bash
yarn ui:web
yarn ui:ios
yarn ui:android
yarn ui:tauri
```

按需要运行其中一个客户端即可。使用与 Relay 对应的账户登录，然后选择目标机器和会话。原生 App 与浏览器遵循相同的认证和会话模型，App 并不是只能查看的简化客户端。

自托管 Relay 时，需要在客户端配置它的 HTTPS 地址。不要把令牌、密码或配对秘密直接写进命令历史、截图、Issue 或 URL。

## 部署控制端

控制端负责维护 Relay 连接，并协调本机或通过 SSH 接入的机器。

安装用户级服务：

```bash
yarn service:install:user
yarn service:status
```

也可以安装系统级服务：

```bash
yarn service:install:system
```

系统级服务可能需要管理员或 root 权限。如果不要求机器在用户登录前运行，或者没有组织策略要求，优先选择用户级服务。

Relay 应只监听回环地址。发布任何 HTTPS 入口前，先验证本地健康状态。推荐使用 Tailscale Serve 提供私有 HTTPS；默认安全模型不包含 Funnel 和局域网明文发布。

完整流程请查看[部署工具包](docs/deployment-kit.md)、[部署架构](docs/deployment.md)和[移动端部署](docs/deployment-kit-mobile.md)。

## 添加另一台电脑

Agent 机器运行 Happier CLI/daemon，并连接控制端的 Relay。Windows、Linux 和 macOS 使用同一套基本流程：

1. 安装已经验证的 Happier Anywhere 发布包，或构建本源码。
2. 配置 Relay 的 HTTPS 地址。
3. 登录目标用户和账户。
4. 安装用户级 daemon 或服务。
5. 核对机器身份，并确认同一会话只有一个写入者。
6. 从 Happier App、桌面端或 Web 启动或发现智能体会话。

部署工具包当前定义以下标准目标：

- `windows-x64`
- `linux-x64-glibc`
- `linux-arm64-glibc`
- `darwin-x64`
- `darwin-arm64`

日常安装和签名发布流程使用 [Happier Anywhere Deploy](https://github.com/ALTair289/Happier-Anywhere-Deploy) 轻量仓库；开发、审计或自行生成可信构建时使用本源码仓库。

## 连接 SSH 机器

可以从控制端使用引导流程配置远端机器：

```bash
happier machine setup --ssh <user@host>
```

SSH 支持显式配置文件、别名、自定义主机名和端口以及 IPv6。主机信任、SSH 与 SCP 共用同一套端点解析。如果执行期间有效配置发生变化，操作会安全停止。对于无法由密钥发现流程安全验证的代理路径，需要显式处理，而不会静默绕过。

接受远端机器前，请确认：

- 解析出的主机和账户确实是目标端点。
- 主机密钥信任通过获批路径建立。
- 远端 daemon 对应预期的 `CODEX_HOME` 或智能体状态目录。
- 没有第二个 daemon 或终端写入同一会话。

## 已有会话与接管模式

Happier Anywhere 区分三种会话行为：

| 模式 | 行为 |
| --- | --- |
| **Direct** | 智能体记录仍以原机器为事实来源。会话最初可能只能观察，原机器离线时也不可用。界面显示 `Direct` 并不能单独证明控制权已经转移。 |
| **Take over** | 将控制权交给 Happier，但不导入原有记录。只能在任务空闲边界执行，并且必须确认准确的会话、所有者和游标。 |
| **Take over + import** | 接管并把已有历史导入 Happier。导入后，原历史必须保持为不变前缀，后续只能追加，不能重复、缺失或覆盖。 |

接管会刻意保持保守。遇到正在执行的工具调用、待处理写入者、所有者不明确、重复 daemon、冲突提示或同步状态未知时，应立即停止。

## 安全基线

- Relay 绑定 `127.0.0.1`，不要绑定 `0.0.0.0`。
- 通过认证 HTTPS 暴露，优先使用私有 Tailscale Serve。
- 除非单独完成威胁建模并明确批准，否则关闭 Tailscale Funnel 和公网入口。
- 使用 WSL2 路径时，不启用 Windows Containers 或无关机器级服务。
- 安装前验证发布校验和、Minisign 签名、平台元数据和容器非 root 元数据。
- 不打印或提交令牌、配对声明、私钥、环境变量转储或携带凭据的 URL。
- 每个智能体会话只保留一个权威写入者。
- 重启、提权、破坏性清理、后端切换和机器级服务都应作为明确审批边界。

安全问题请按 [SECURITY.md](SECURITY.md) 提交。供应链和构件规则见 [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `yarn tui` | 启动引导式本地开发控制台 |
| `yarn dev` | 启动后台开发栈 |
| `yarn stop` | 停止仓库管理的后台进程 |
| `yarn cli:activate` | 激活本地构建的 CLI |
| `yarn auth` | 运行仓库认证辅助命令 |
| `yarn daemon` | 运行 daemon 工作区命令 |
| `yarn server:light` | 启动轻量服务端开发模式 |
| `yarn ui:web` | 运行 Web 客户端 |
| `yarn ui:tauri` | 运行桌面客户端 |
| `yarn service:status` | 查看已安装服务状态 |
| `yarn tailscale:status` | 查看仓库关联的 Tailscale 状态 |
| `yarn typecheck` | 检查全部工作区类型 |
| `yarn test` | 运行仓库测试 |
| `yarn scan:source:filenames` | 扫描疑似秘密文件名 |
| `yarn scan:source:secrets` | 运行脱敏源码秘密扫描 |

## 开发与验证

开发时运行聚焦检查，发布前再运行更完整的验证：

```bash
yarn typecheck
yarn test
yarn test:integration
yarn scan:source:filenames
yarn scan:source:secrets
```

发布构建必须保留完整的五平台目录。被标记为已验证的部署目录不能遗漏任何目标，也不能缺少 controller 或 agent 角色。发布证据、校验和、签名和源码来源必须指向同一个精确提交及同一组构件。

技术文档入口：

- [文档索引](docs/README.md)
- [CLI 架构](docs/cli-architecture.md)
- [Codex 功能矩阵](docs/codex-feature-matrix.md)
- [二进制运行时](docs/binary-runtime.md)
- [发布流程](docs/release-process.md)
- [待处理交付模型](docs/pending-delivery.md)

## 贡献与上游同步

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。Happier Anywhere 的改动应保持可审查，同时保留上游历史，便于后续安全地审计和合并 Happier 更新。上游同步和来源规则见 [UPSTREAM.md](UPSTREAM.md)。

## 许可证

本项目使用 MIT License，详见 [LICENCE](LICENCE) 和 [NOTICE](NOTICE)。
