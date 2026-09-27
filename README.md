# claude-log

**项目级任务审计日志插件** — 在你对 Claude Code 说"任务完成"那一刻，自动把本轮对话蒸馏为三段式摘要，追加到全局档案 `$HOME/.cai/projects/$hash/history.md`(其中 `hash = sha1(项目绝对路径)`)。用 `/his` 命令随时回看；新开 session 时自动注入近期任务摘要。

---

## 解决什么问题

Claude Code 不会自动记录你让它做了什么、为什么这么做、踩了哪些坑。几天后回来，你已经忘了当时选了方案 A 还是方案 B。

claude-mem 能帮你做机器级召回（"上次那个 bug 怎么修的？"），但它吐出来的是 tool-call 级别的碎片信息。你需要一份**人读的决策日志**，告诉你**为什么而非做了什么**。

本插件填的就是这个空：

- **谁写的**：Claude 在你每轮"任务完成"后自动蒸馏（不需你手动整理）
- **写在哪**：`$HOME/.cai/projects/$hash/history.md` (全局、按项目路径哈希分桶)
- **写了什么**：需求/问题 → 决策/方案 → 验收/总结，三段式
- **怎么看**：`/his`（今天）、`/his 3`（近 3 天）；新 session 启动时自动注入最近 10 条/10 天内的条目

---

## 与 claude-mem 的关系

| 维度 | claude-log | claude-mem |
|---|---|---|
| 触发 | ✅ 主动（你说"任务完成"） | 🔄 被动（每个 tool call） |
| 存储 | 📄 `$HOME/.cai/projects/$hash/history.md` | 🗄️ 全局 SQLite + Chroma |
| 读者 | 👤 人(+ 启动时注入给 AI) | 🤖 AI（语义检索） |
| 粒度 | 📋 任务级 | 🔬 tool-call 级 |
| 跨项目 | ❌ 按哈希隔离 | ✅ 全局检索 |
| git 跟踪 | ❌ 在 `$HOME` 下,不进项目仓库 | ❌ 数据库在 ~/.claude-mem/ |

**两者并存最佳**：claude-mem 处理"细枝末节召回"，本插件守住"决策审计"。

> 💡 若想把 history.md 纳入项目 git,可在项目内建符号链接,再把该链接加入仓库:
> ```bash
> hash=$(printf '%s' "$PWD" | { command -v sha1sum >/dev/null 2>&1 && sha1sum || shasum -a 1; } | awk '{print $1}')
> ln -s "$HOME/.cai/projects/$hash/history.md" history.md
> ```

---

## 功能一览

### 1. 自动归档（Stop hook）

每轮回复结束后，插件的 Stop hook 检查你是否说出了"**任务完成**"。若是，hook 拦截下一轮、注入写指令，Claude 自动把本轮任务以三段式追加到 `$HOME/.cai/projects/$hash/history.md`：

```markdown
## 2026-05-30-T001：修复登录页面 token 刷新失效

- **需求/问题**：登录后 15 分钟内 token 过期未自动续期，导致 API 403，用户需反复登录。
- **决策/方案**：在 axios 拦截器中检查 401 响应码，用 refreshToken 静默续期（放弃在路由守卫中前置检查，太重且对非路由 API 无效）。
- **验收/总结**：axios.interceptors.response 新增 reject→401 判断 + retry 队列防并发刷新；手动测试过期 token 场景 + E2E 用例 login-refresh.spec.ts；遗留：refreshToken 本身过期时只弹登录页，未做平滑重定向。
```

**触发保护**：
- 仅"任务完成"出现在末尾时才触发（句中不会误触）
- 前 8 字内有否定词（"避免说"、"不要再说"、"请不要"）时自动跳过
- stop_hook_active 标示防死循环（归档完成后不再二次触发）

### 2. 启动注入（SessionStart hook)

每次启动/恢复/clear session 时,插件的 SessionStart hook 自动:

1. 计算当前项目哈希,确保档案目录 `$HOME/.cai/projects/$hash/` 与 `path` 文件就绪
2. 读取 `history.md` 末尾 **10 条** 任务(且发生在最近 **10 天** 内),通过 `additionalContext` 注入到本次 session

让 Claude 启动时就能"想起"近期工作进展。

**可配置**(环境变量):
- `CLAUDE_LOG_RECENT_N`(默认 10)— 最多注入条数
- `CLAUDE_LOG_RECENT_DAYS`(默认 10)— 时间窗(天)

### 3. `/his` — 回看任务历史

```
/his      → 今天
/his 1    → 今天
/his 2    → 今天 + 昨天
/his 3    → 今天 + 昨天 + 前天
/his N    → 最近 N 天
/his 7    → 最近一周
/his 30   → 最近一个月
```

输出倒序排列，完整保留三段原文（不做二次摘要）。末尾附日期维度条数统计。

### 4. 灵活配置

编辑 `scripts/stop-hook.js` 顶部的常量即可：

- `TRIGGER_PHRASE` — 触发关键词（默认"任务完成"）
- `NEGATION_TOKENS` — 否定/排除词列表
- `NEGATION_WINDOW` — 否定词检测窗口大小（字符数）
- `PROJECT_ARCHIVE_ROOT` — 档案根(默认 `$HOME/.cai/projects`)
- `HISTORY_FILE` — 归档文件名(默认 `history.md`)

`scripts/session-start-hook.js` 顶部同样有 `DEFAULT_RECENT_N` / `DEFAULT_RECENT_DAYS` 可改。

---

## 安装

### 前提

- Node.js（Claude Code 自带即可）
- `rsync`（macOS 预装；Linux 通常已装）
- Claude Code 已安装（需要 `claude` CLI）

### 安装步骤

```bash
cd /path/to/claude-log
./install       # 显示帮助（默认安全，不直接装）
./install -i    # 安装
```

安装做了什么：

1. 生成 marketplace 清单到 `~/.claude/plugins/marketplaces/claude-log-local/`
2. rsync 拷贝源码到 marketplace 目录（真目录，非 symlink — Claude Code 要求）
3. 调用 `claude plugin marketplace add` 注册 marketplace
4. 调用 `claude plugin install` 启用插件

### 其他命令

```bash
./install -h    # 帮助
./install -s    # 查看安装状态
./install -r    # 重装（卸载后重新安装）
./install -u    # 卸载（保留 $HOME/.cai/projects/ 下历史不动）
```

**⚠️ 重要：源码改了之后必须跑 `./install -r`，否则 marketplace 镜像还是旧代码。**

---

## 使用流程

```
1. 你下达任务           Claude 正常执行，不做任何记录
2. …工作完成…
3. 你说："任务完成"      Stop hook 命中，拦截下一轮
4.                       Claude 自动蒸馏上下文，追加三段式条目
5. 继续下一个任务         /his 随时回看;下次启动时近期条目自动注入
```

**关键是第 3 步要说"任务完成"这四个字** —— 它是你签收当前任务的信号，触发归档。

---

## 数据格式

### 任务 ID 规则

`YYYY-MM-DD-Txxx`

- 日期 = 归档发生的本地日期
- Txxx = 当日自增（从 T001 开始，最大 T999）
- 每次归档前扫描已有条目找最大编号 +1

### 存储位置

```bash
# 项目识别(等价于 sha1 当前目录绝对路径;macOS 无 sha1sum 用 shasum -a 1 兜底)
hash=$(printf '%s' "$PWD" \
  | { command -v sha1sum >/dev/null 2>&1 && sha1sum || shasum -a 1; } \
  | awk '{print $1}')

# 归档结构
$HOME/.cai/projects/<hash>/
├── path            # 项目绝对路径(便于反查"这个 hash 是哪个项目")
└── history.md      # 三段式归档,Stop hook 写入,/his 读取
```

为什么不放在项目内?
- 避免污染项目根目录(很多团队对项目内新增追踪文件敏感)
- 工作目录改名/移动不影响——但若你 `mv` 了项目目录,会被识别成新项目,旧 hash 仍在 `$HOME/.cai/projects/` 留底,可手动迁移或软链。

### 文件样例

```markdown
## 2026-05-30-T001：移植 claude-mem 上游提交到本地 fork

- **需求/问题**：claude-mem-github 在 37d24944 之后有 7 个新提交，需逐一评估并移植到本地改造版，保证本地先进性。
- **决策/方案**：按时间顺序逐一独立提交移植；跳过版本号 bump 和 CHANGELOG 回填（本地有大量私有特性，不与上游版本号同步）；手工合并 worker-service.ts 和 SettingsDefaultsManager.ts（本地已为 server-mode 大幅改造）。
- **验收/总结**：5 个移植提交全部通过 byte-equality diff 校验（skills、.mcp.json 删除、transcript 修复）；提交 b0e896e2 的 SettingsDefaultsManager.ts 合并时顺手去掉了相邻 2 行 trailing space（纯 cosmetic）；tests/install-non-tty.test.ts 发现上游遗漏 bug 并同步修复。
```

---

## 注意事项

### ⚠️ 时机

- 只有"任务**彻底完成**"时才说那四个字——它是一份**签收单**，不是"这一轮快结束了"。
- 说了却不满意？不要说"任务完成"，直接要求 Claude 继续。
- 归档完成后 Claude 不会再自动追加补充内容，如需追加，手动编辑 `$HOME/.cai/projects/$hash/history.md`。

### ⚠️ 并发

- 同一项目同时跑多个 Claude Code 窗口，且同一秒内都说"任务完成"：Txxx 可能冲突（极小概率）。正常使用不受影响。

### ⚠️ 文件大小

- `history.md` 会持续增长。建议在积累到 ~500 KB 后手动归档老条目到同目录的 `history.archive.md`。`/his` 读到 >500 KB 时会提醒。

### ⚠️ 与 CLAUDE.md 全局规则的协作

- 你的 `~/.claude/CLAUDE.md` 中的"任务完成"流程现在与本插件等价(都指向 `$HOME/.cai/projects/$hash/history.md`)。本插件**不取代**提示词，而是**加固**它——Stop hook 确保即使某次对话 Claude 忘记写,hook 也会补上。
- SessionStart hook 自动注入近期历史,免去 CLAUDE.md 中"启动时扫描历史"的人工依赖。

### ⚠️ 卸载

- `./install -u` 只删 marketplace 与 settings 中的注册项，**不动 `$HOME/.cai/projects/` 下任何历史数据**。你的历史数据永远归你。
- 如需恢复:`./install -i` 即可重新加载。如需彻底清除某项目历史:`rm -rf $HOME/.cai/projects/<hash>`(慎用)。

---

## 目录结构

```
claude-log/
├── .claude-plugin/
│   └── plugin.json              # 插件 manifest
├── hooks/
│   └── hooks.json               # SessionStart + Stop hook 注册
├── commands/
│   └── his.md                   # /his 斜杠命令（参数解析 + 回看逻辑）
├── skills/
│   └── his/
│       └── SKILL.md             # /his 自然语言触发版（"今天做了什么"等）
├── scripts/
│   ├── stop-hook.js             # Stop hook 脚本（触发检测 + Txxx 编号推算 + 路径解析）
│   └── session-start-hook.js    # SessionStart hook 脚本（路径就绪 + 历史注入）
├── templates/
│   └── aitask-entry.md          # 三段式模板（提供给 Claude 写入时的字段指引）
├── install                      # 安装/卸载/重装 shell
└── README.md
```

### 各组件职责

| 组件 | 角色 |
|---|---|
| `hooks/hooks.json` | 声明 SessionStart + Stop 两个 hook |
| `scripts/stop-hook.js` | 检查末轮 assistant 文本是否以"任务完成"落款 → 是则 block + 注入 reason(含 history.md 绝对路径) |
| `scripts/session-start-hook.js` | 启动时:确保 proj 目录就绪 + 注入近期条目 |
| `templates/aitask-entry.md` | 模板文件，定义三段式字段与写入规范；被 hook reason 引用 |
| `commands/his.md` | 斜杠命令入口：解析 `[N]` 参数，调度执行步骤 |
| `skills/his/SKILL.md` | 自然语言触发入口：当用户问"今天做了什么"等时自动匹配 |
| `install` | 部署脚本：rsync 拷贝 + CLI 注册 marketplace + 启用插件 |

### 触发判定流程

```
Stop hook 触发
    │
    ▼
stop_hook.js 读 stdin JSON
    │
    ├─ stop_hook_active === true? ────▶ continue（防死循环）
    │
    ├─ 末轮 assistant 不含 "任务完成"? → continue
    │
    ├─ 末尾锚定检查失败? ──────────────▶ continue（句中/中段出现）
    │
    ├─ 否定词命中? ────────────────────▶ continue（meta 引用/否定）
    │
    ▼
  解析 proj/history.md 路径 → mkdir + 写 path 文件
    │
    ▼
  block + reason（下一轮 Claude 写文件,reason 含 historyPath/taskId）
```

```
SessionStart hook 触发(startup|resume|clear)
    │
    ▼
session_start_hook.js 读 stdin JSON 取 cwd
    │
    ▼
  hash = sha1(cwd) → 建 proj/ → 写 proj/path
    │
    ▼
  history.md 不存在? ──▶ {"continue":true}(空注入)
    │
    ▼
  解析 ## YYYY-MM-DD-Txxx 段头 → 取最近 N 条且近 D 天内
    │
    ▼
  输出 hookSpecificOutput.additionalContext(近期任务摘要)
```

---

## 故障排查

| 症状 | 检查 |
|---|---|
| `/plugin` 报 "Plugin not found in marketplace" | `./install -s` 确认 marketplace 注册状态；若未注册，重跑 `./install -r` |
| 说"任务完成"后没触发归档 | `./install -s` 确认插件启用；检查 `~/.claude/plugins/known_marketplaces.json` 有本 marketplace；确认 node 在 PATH |
| `/his` 说文件不存在 | 当前项目还没说过"任务完成"——首次归档后 `history.md` 自动创建 |
| 启动时没注入历史 | 1) 当前项目无任何归档;2) 最近 10 天内无条目;3) Hook 未生效(`./install -s` 检查) |
| Txxx 编号有跳号 | 正常：某些归档可能因 markdown 格式问题未产生 `##` 段头，下一轮继续递增（不影响使用） |

---

## License

MIT
