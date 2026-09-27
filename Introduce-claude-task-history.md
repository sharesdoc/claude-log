# claude-task-history

> Claude Code 的任务级审计日志插件 — 对 Claude 说"任务完成"即自动生成三段式决策摘要，跨 session 持久化审计。

## 这是什么

一个 Claude Code 插件，通过 Stop hook 和 SessionStart hook 实现任务历史的自动归档与注入。当你对 Claude 说"任务完成"时，插件自动拦截下一轮对话，将本轮工作蒸馏为"需求/问题 → 决策/方案 → 验收/总结"三段式摘要，追加到全局档案 `$HOME/.cai/projects/$hash/history.md`；下次启动 session 时自动注入近期任务摘要，让 Claude 记住你做过什么。

- **仓库地址**：`git@git.hnzhzw.com:ai/plugins/claude-task-history.git`
- **本地路径**：`/Users/johnson/wks/ai/plugins/claude-task-history`
- **当前分支**：`main`
- **最新提交**：2026-06-17
- **版本**：v0.3.0（未发布 tag，仅见 plugin.json 中标注）

## 解决什么问题

Claude Code 不会自动记录你让它做了什么、为什么这么做、踩了哪些坑。几天后回来已忘记当时选了方案 A 还是方案 B。claude-mem 提供 tool-call 级的机器召回（碎片化信息），但缺一份**人类可读的决策日志**。本插件填这个空：自动帮你签收每轮任务，留下人读的审计记录，新 session 启动时还能让 Claude 主动想起近期进展。

## 核心功能与特点

1. **自动归档** — Stop hook 检测"任务完成"短语（仅末尾命中），拦截下一轮，注入三段式写入指令（附带模板 `templates/aitask-entry.md`），Claude 自动追加到全局历史文件。含否定词保护（"不要再说任务完成"等场景自动跳过）和死循环保护（`stop_hook_active` 标示）。
2. **启动注入** — SessionStart hook 在每次启动/恢复/clear session 时自动计算当前项目 sha1 哈希，确保档案目录和 `path` 文件就绪；读取最近 5 条（14 天内）历史通过 `additionalContext` 注入，让 Claude 启动时"想起"近期工作。条数和时间窗可通过环境变量 `CLAUDE_TASK_HISTORY_RECENT_N` / `CLAUDE_TASK_HISTORY_RECENT_DAYS` 配置。
3. **/his 命令** — 回看任务历史：`/his`（今天）、`/his N`（最近 N 天），输出倒序排列、保留三段原文、末尾附日期维度条数统计。
4. **自然语言触发** — 配套 `/his` skill（如"今天做了什么"），由 hooks 自动匹配。
5. **存储隔离** — 档案存于 `$HOME/.cai/projects/`（按 sha1 哈希分桶），不污染项目目录，工作目录改名/移动不影响。

## 什么时候用

- 日常使用 Claude Code 时：无论修 bug、加功能、改配置，任务完成后都说"任务完成"让插件自动记录。
- 需要跨 session 跟踪项目进展时：每次启动 Claude Code 自动获得近期上下文。
- 需要复盘近期工作时：`/his` 命令一键回看。

## 怎么用

### 自动生效
安装后，所有功能通过 hook 自动运行，无需手动干预：
- 每次对话末尾说出"任务完成"，自动触发归档。
- 每次启动/恢复 session，自动注入近期历史。

### 手动操作
- `/his` — 查看今天的任务历史。
- `/his 7` — 查看最近一周。
- `/his 30` — 查看最近一个月（上限 30 天）。

## 技术栈

- **运行环境**：Node.js（Claude Code 内置即可）
- **宿主**：Claude Code Plugin System（hooks + commands + skills 架构）
- **依赖**：仅 `rsync`（macOS 预装；Linux 通常已装）
- **存储**：纯 Markdown 文件（`$HOME/.cai/projects/$hash/history.md`），无数据库依赖

## 核心架构

```
claude-task-history/
├── .claude-plugin/plugin.json          # 插件 manifest（name/version/author）
├── hooks/hooks.json                    # 注册 SessionStart + Stop 两个 hook
├── scripts/
│   ├── stop-hook.js                    # 触发检测 + 路径解析 + block + reason 注入
│   └── session-start-hook.js           # 目录就绪 + 历史注入
├── templates/aitask-entry.md           # 三段式写入模板（被 hook reason 引用）
├── commands/his.md                     # /his 斜杠命令（参数解析 + 回看逻辑）
├── skills/his/SKILL.md                 # /his 自然语言触发版
└── install                             # 安装/卸载/重装 shell 脚本（rsync + CLI）
```

触发流程：Stop hook 检查末轮 assistant 文本 → 末尾锚定"任务完成"且无否定词 → 解析项目 hash → 预建目录 → block 并注入 reason（含 historyPath + taskId）→ Claude 自动写入三段式归档。SessionStart hook 在 startup/resume/clear 时计算 hash → 建目录 + 写 path 文件 → 读取最近 N 条注入 `additionalContext`。

## 本地安装 / 卸载

```bash
cd /path/to/claude-task-history
./install -i    # 安装
./install -s    # 查看安装状态
./install -r    # 重装（源码修改后必须重装）
./install -u    # 卸载（保留 $HOME/.cai/projects/ 下历史不动）
./install -h    # 帮助
```

**前提**：Node.js、rsync、已安装 Claude Code CLI。
**注意事项**：源码修改后必须 `./install -r`，否则 marketplace 镜像还是旧代码。

## 隐私与数据安全

- **存本地**：所有历史数据保存在 `$HOME/.cai/projects/`，归属用户本地机器，不发送到任何外部服务。
- **不跟踪 git**：档案放在 `$HOME` 下，不进项目仓库，不会污染你的代码提交。
- **卸载留数据**：`./install -u` 只删除 marketplace 注册，不删除任何历史记录。
- **基于代码扫描，未发现数据外传、网络请求或收集用户隐私的行为**。

## 开源许可

MIT（见 `plugin.json` 的 license 字段及 README 末尾声明）

## 维护状态

活跃维护中。作者：Johnson（Johnson@mailbox.com）。当前版本 v0.3.0，近期更新包括存储根路径迁移、Stop hook OCR 兼容性修复、安装脚本无损迁移等迭代。最后提交日期：2026-06-17。近 3 个月 10 次提交。

## 成熟度与竞品对比

同类方案对比：

| 维度 | claude-task-history | claude-mem |
|---|---|---|
| 触发方式 | 主动（你说"任务完成"） | 被动（每个 tool call） |
| 存储形式 | `$HOME/.cai/projects/$hash/history.md` | 全局 SQLite + Chroma |
| 读者 | 人（+ 启动时注入给 AI） | AI（语义检索） |
| 粒度 | 任务级（三段式摘要） | tool-call 级（碎片化） |
| 跨项目查询 | 按哈希隔离 | 全局检索 |

两者可并存：claude-mem 处理细节召回，本插件守住决策审计。

## 了解更多

- 项目 README：`/Users/johnson/wks/ai/plugins/claude-task-history/README.md`
- 插件清单：`.claude-plugin/plugin.json`
- Hook 注册：`hooks/hooks.json`
- 安装脚本：`install`
- 数据模板：`templates/aitask-entry.md`
