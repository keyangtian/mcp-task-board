# 发布到 GitHub（三条路，任选一条）

仓库已经在本地初始化好并提交了（`main` 分支，13 个测试全绿）。缺的只是"谁来认证"。

## 路线一：网页建仓 + 一次 push（最省事，推荐）

1. 打开 https://github.com/new
2. Repository name 填 `mcp-task-board`，选 **Public**，**不要**勾选 "Add a README file"
3. 在本机执行：

```powershell
cd C:\Users\Administrator\agent-board
git remote add origin https://github.com/<你的用户名>/mcp-task-board.git
git push -u origin main
```

第一次 push 会弹出 Git Credential Manager 的浏览器登录，登一次以后就不用再登。

## 路线二：gh CLI

```powershell
winget install --id GitHub.cli -e
gh auth login          # 选 GitHub.com -> HTTPS -> 浏览器登录
cd C:\Users\Administrator\agent-board
gh repo create mcp-task-board --public --source . --push `
  --description "A dependency-aware task board for heterogeneous AI agents: atomic claims, leases, capability routing, artifacts, MCP server + CLI, zero dependencies."
```

## 路线三：用一个 PAT 让脚本自动建仓并推送

在 **你自己的终端**里执行（不要把 token 贴到聊天窗口里）：

```powershell
$env:GITHUB_TOKEN = "ghp_你的token"      # 需要 repo 权限
cd C:\Users\Administrator\agent-board
node publish.mjs
```

脚本会：查当前账号 → 没有仓库就用 API 建 → 设置 remote → push。
token 只从环境变量读，交给 git 时走一次性的 `http.extraheader`，不写进 `.git/config`，也不打印。

## 推完建议顺手做的四件事

1. 仓库页右上角 **About → Topics** 加：
   `mcp` `model-context-protocol` `multi-agent` `ai-agents` `task-queue` `orchestration` `claude-code` `workbuddy` `deepseek-harness`
2. 确认 **Actions** 跑过一次（`.github/workflows/ci.yml` 会在 ubuntu/windows/macos × node 18/20/22 上跑测试），绿了之后在 README 顶部加 badge：
   `![test](https://github.com/<user>/mcp-task-board/actions/workflows/ci.yml/badge.svg)`
3. Release 打一个 `v0.1.0`，附一句"first cut: board + MCP + CLI"
4. 想涨 star 的话，把 `examples/dsh-workbuddy.md` 里那套"两个桌面智能体共享一块板"的过程录成 20 秒 GIF 放 README 顶部——这种跨产品的真实用法比功能列表更容易被转发。

## 为什么不是别人已经做过的

[sugar](https://github.com/roboticforce/sugar) 已经覆盖了队列 + 租约 + MCP（101★），我们没重复它的部分。
这块板的差异只有三点，README 的 "Related work" 一节写明了：认领时强制能力路由、产物只存引用与 sha256、零依赖到能塞进 U 盘。
