# DevLoop 部署说明

> 本文档仅面向**可选**的多人共享部署场景。个人使用 DevLoop 请下载 Electron 安装包或使用源码运行，参见 [README](./README.md)。只有当你需要多台设备连接同一份 SQLite 与执行队列时才需要按本文档部署。

## 1. 部署结果

每次安装都会得到一套独立 DevLoop 实例：

```text
浏览器 / 手机 / Electron
          |
          v
用户自己的 DevLoop Server
├── Codex CLI 与配置
├── SQLite（任务与运行事件）
├── Git 托管仓库与 Worktree
└── Skill
```

DevLoop 不提供注册和登录。能够访问实例入口的人拥有实例所有者权限，因此不要把 `4317` 端口直接暴露到公网。

## 2. 服务器要求

推荐环境：

- Linux x86_64 或 arm64。
- Docker Engine 24 及以上。
- Docker Compose 插件。
- 至少 2 核 CPU、4 GB 内存和 20 GB 可用磁盘。
- 能访问代码托管平台和 Codex Provider。
- 宝塔只负责域名、HTTPS 和反向代理，不使用 PM2 启动 DevLoop。

当前镜像自带 Node.js、Git、OpenSSH 客户端和 Codex CLI。任务项目需要 Java、Python、Go 等额外工具链时，应基于当前 Dockerfile 制作自己的镜像。

## 3. 准备目录

在服务器中进入项目目录后执行：

```bash
mkdir -p data config/codex config/ssh
cp .env.example .env
```

目录用途：

```text
data/          SQLite、仓库、Worktree 和 Skill
config/codex/  Codex 配置与登录凭据
config/ssh/    Git 私钥、config 和 known_hosts
```

容器使用 UID `10001` 运行。首次启动前确保数据和 Codex 配置目录可写：

```bash
sudo chown -R 10001:10001 data config/codex config/ssh
sudo chmod 700 config/ssh
sudo chmod 600 config/ssh/id_* 2>/dev/null || true
sudo chmod 644 config/ssh/known_hosts 2>/dev/null || true
```

## 4. 配置 Git SSH

把只用于 DevLoop 的部署私钥放入 `config/ssh`。建议为不同代码平台使用单独的 Deploy Key，不要挂载个人主密钥。

示例 `config/ssh/config`：

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
```

在可信环境生成 `known_hosts`，核对指纹后再放到服务器：

```bash
ssh-keyscan github.com > config/ssh/known_hosts
```

阿里云 Codeup 或其他平台需要替换 Host，并按平台文档核对主机指纹。

## 5. 配置 Codex

有两种方式。

### 5.1 使用 API Key

编辑 `.env`：

```text
OPENAI_API_KEY=你的密钥
```

自定义 Provider 使用现有 Codex 配置时，把 `config.toml` 等文件放进 `config/codex`。DevLoop 默认继承该目录中的 Provider、模型、Skill 和 MCP 配置。

### 5.2 在容器中完成 Codex 登录

先构建镜像，然后临时进入容器登录：

```bash
docker compose build
docker compose run --rm devloop codex login
docker compose run --rm devloop codex login status
```

登录状态写入 `config/codex`，容器重建后仍保留。

服务日志写入容器标准输出，并由 Compose 配置按大小轮转。使用 `docker compose logs` 查看，不需要在 `data` 中维护日志目录。

## 6. 启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f devloop
```

健康检查：

```bash
curl http://127.0.0.1:4317/api/health
```

首次只验证界面时，可以把 `.env` 中的执行器改为：

```text
DEVLOOP_RUNNER=fake
```

该模式不会调用真实 Codex。

## 7. 宝塔反向代理

1. 在宝塔创建站点并绑定域名。
2. 申请并强制启用 HTTPS。
3. 将 [宝塔 Nginx 模板](./deploy/baota-nginx.conf) 中的 `location /` 配置加入站点。
4. 在宝塔中启用 Basic Auth、IP 白名单，或让站点只通过 Tailscale 可达。
5. 不在安全组或防火墙开放 `4317`。

SSE 依赖关闭代理缓冲，模板中的 `proxy_buffering off` 和长连接超时不能删除。

## 8. 手机访问

推荐顺序：

1. Tailscale：服务器和手机加入同一 Tailnet，使用私有域名或 Tailscale HTTPS。
2. 宝塔 HTTPS + IP 白名单：适合出口 IP 稳定的环境。
3. 宝塔 HTTPS + Basic Auth：适合确实需要公网访问的个人实例。

手机打开与桌面端相同的地址即可查看和修改任务。DevLoop 不会让手机直接读取服务器任意文件或执行任意 Shell 命令。

## 9. 更新

更新前先备份，再拉取代码并重建：

```bash
docker compose stop devloop
tar -czf "devloop-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data config
docker compose up -d --build
docker compose logs --tail=200 devloop
```

数据库迁移在 Server 启动时自动执行。SQLite 只能由一个 DevLoop Server 实例使用，不要同时启动旧容器和新容器连接同一个 `data` 目录。

## 10. 备份与恢复

一致性要求最高的简单备份方式：

```bash
docker compose stop devloop
tar -czf "devloop-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data config
docker compose start devloop
```

恢复步骤：

1. 停止 DevLoop。
2. 保留当前 `data` 和 `config` 作为回滚副本。
3. 解压备份到原目录。
4. 确认目录所有者为 UID `10001`。
5. 启动并检查健康接口和日志。

## 11. 更换服务器

迁移以下内容即可：

```text
data/
config/codex/
config/ssh/
.env
```

远程 Git 仓库仍是代码的团队事实来源，`data/repositories` 和 `data/worktrees` 用于保留执行现场与审计信息。完整迁移时应一起复制。

## 12. 常见问题

### Codex 显示不可用

执行：

```bash
docker compose run --rm devloop codex --version
docker compose run --rm devloop codex login status
docker compose logs --tail=200 devloop
```

检查 `config/codex` 是否可写、API Key 是否传入，以及自定义 Provider 是否能从服务器网络访问。

### Git 仓库克隆失败

执行：

```bash
docker compose run --rm devloop ssh -T git@github.com
```

检查私钥权限、Deploy Key 授权、`known_hosts` 和 SSH Host 配置。

### 页面能打开但状态不实时更新

确认宝塔 Nginx 已关闭代理缓冲，并将 `proxy_read_timeout` 设置为长连接时间。

### 容器反复重启

查看：

```bash
docker compose logs --tail=300 devloop
```

常见原因是 `data` 无写权限、迁移文件缺失、端口被占用或 Codex 配置目录权限不正确。
