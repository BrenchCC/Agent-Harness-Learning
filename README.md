# Agent Harness Learning

本仓库维护 [`awesome-agent-architecture`](https://github.com/hardness1020/awesome-agent-architecture) 的 Git 子模块，并将其中的简体中文内容持续镜像到飞书知识库。

当前镜像包含 25 个 `README.zh-CN.md` 页面、26 个仓库本地图片资源，以及 1 个 GitHub Attachment 动图。仓库是内容的唯一来源；同步程序不会在页面末尾附加同步声明、源文件链接或上游提交 SHA。

## 功能

- 按上游中文目录顺序维护飞书 Wiki 层级。
- 将中文内部链接改写为飞书 Wiki 节点链接。
- 上传本地图片，并将图片字节纳入内容哈希。
- 将受信任的 GitHub Attachment 下载到受管临时缓存后作为本地素材上传，避免 GIF 被飞书远端抓取转换成静态图片。
- 支持只读计划、增量同步、完整同步和远端验证。
- 使用远端版本化清单保存节点 Token、正文哈希和同步状态。
- 保留重命名节点的 Token，并将上游删除内容移动到归档节点。
- 支持中断恢复；同步成功前不会推进最后成功的上游 SHA。
- 每天北京时间 12:00 自动检查上游并同步。

## 项目结构

```text
.
├── awesome-agent-architecture/          # 上游 Git 子模块
├── scripts/feishu-sync/                 # 内容模型、飞书客户端和同步状态机
├── scripts/feishu-wiki-sync.mjs         # 同步 CLI 入口
├── test/feishu-sync.test.mjs            # 转换与状态机测试
└── .github/workflows/
    └── sync-awesome-agent-architecture.yml
```

## 环境要求

- Node.js 22 或更高版本
- Git
- curl（Node 网络请求失败时用于公开附件下载回退）
- `@larksuite/cli@1.0.86`
- 已获得目标飞书知识空间权限的飞书应用

安装飞书 CLI：

```bash
npm install --global @larksuite/cli@1.0.86
```

## 获取仓库

```bash
git clone --recurse-submodules https://github.com/BrenchCC/Agent-Harness-Learning.git
cd Agent-Harness-Learning
```

已有本地仓库时初始化子模块：

```bash
git submodule update --init --recursive
```

## 本地检查

运行测试：

```bash
npm test
```

检查源内容数量、标题和资源：

```bash
npm run check:feishu-sync
```

## 同步命令

远端命令需要配置 `FEISHU_SPACE_ID` 和 `FEISHU_ROOT_NODE_TOKEN`，并确保 `lark-cli` 当前配置可使用 Bot 身份访问目标空间。

生成只读计划：

```bash
node scripts/feishu-wiki-sync.mjs plan --mode incremental
```

执行增量同步：

```bash
node scripts/feishu-wiki-sync.mjs apply --mode incremental
```

执行完整同步：

```bash
node scripts/feishu-wiki-sync.mjs apply --mode full
```

验证全部受管页面：

```bash
node scripts/feishu-wiki-sync.mjs verify
```

首次创建远端清单和辅助节点时，仅对专用且无未知子节点的根页面执行：

```bash
node scripts/feishu-wiki-sync.mjs apply --mode full --bootstrap
```

同步报告默认写入 `artifacts/feishu-sync-report.json`，其中包含父仓库 SHA、上游 SHA、操作计数和告警。

## GitHub Actions 配置

在仓库 Actions Secrets 中配置：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

在仓库 Actions Variables 中配置：

- `FEISHU_SPACE_ID`
- `FEISHU_ROOT_NODE_TOKEN`

工作流支持以下触发方式：

- 每天 `04:00 UTC`，即北京时间 12:00 定时执行。
- 手动选择 `plan`、`apply` 或 `verify`，以及 `incremental` 或 `full` 模式。
- Pull Request 修改同步工具、测试或工作流时执行只读校验。
- 推送到 `main` 且修改子模块指针、同步工具、测试、工作流、`package.json` 或 `.gitmodules` 时执行增量同步。

当上游 `main` 出现新提交时，工作流会更新子模块指针并创建如下格式的提交：

```text
chore: update awesome-agent-architecture submodule

- Advance upstream from <old-sha> to <new-sha>
```

## 同步安全策略

- 只覆盖清单中明确受管的飞书页面。
- 未知节点不会被修改或删除。
- 重复 Token、清单损坏或父子关系漂移会使同步失败并停止写入。
- 上游删除的最高层受管节点会移动到“归档（系统）”。
- 同一知识空间内的写操作保持串行，并对临时网络故障进行有限重试。
- GitHub Attachment 仅允许稳定的 `github.com/user-attachments/assets/...` 地址；临时签名 URL 不会保存，上传结束后清理缓存。
- 日志和同步报告不得包含应用 Secret 或访问令牌。

## 飞书镜像

[查看 Awesome Agent Architecture 中文知识库](https://nwtbnnqpuup.feishu.cn/wiki/CCJSwGgIciTnfKkkhIJcK33Pnug)
