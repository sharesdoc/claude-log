#!/usr/bin/env node
/**
 * claude-task-history — Stop hook 脚本
 *
 * ## 设计目的
 *
 * Claude Code 在每一轮 assistant 回复完成后触发 Stop hook。本脚本读取最新
 * transcript，判断末轮 assistant 是否以「任务完成」落款。若是，则通过
 * Claude Code 的 Stop-hook 阻断机制（decision="block"）向 Claude 注入一条
 * 指令，要求它按 templates/aitask-entry.md 的三段式模板把本轮任务追加到
 * 项目档案 `$HOME/.cai/projects/<sha1(cwd)>/history.md` 末尾。
 *
 * ## 两阶段分工
 *
 * ┌─ 本脚本（执行于 hook 进程）─────────────────────┐
 * │ 1. 读取 stdin 拿到 transcript_path / cwd /       │
 * │    stop_hook_active                              │
 * │ 2. 解析最后一条 assistant 消息，检查是否落款     │
 * │ 3. 扫描已有 history.md 推算下一个 Txxx 编号       │
 * │ 4. 产出 block decision + reason（下发写指令）     │
 * └────────────────────────────────────────────────┘
 * ┌─ Claude（下一轮被 block reason 唤醒）──────────┐
 * │ 5. 读取 reason 中的 templatePath / taskId /     │
 * │    historyPath / 字段要求                        │
 * │ 6. 综合本轮对话上下文，蒸馏三段式内容             │
 * │ 7. 追加到 historyPath（Read/Write/Edit tools）   │
 * │ 8. 不说「任务完成」，避免二次触发                 │
 * └────────────────────────────────────────────────┘
 *
 * ## 为什么不让本脚本直接写文件
 *
 * Python/Node 脚本无法访问本轮对话上下文（tool call 记录、用户意图、
 * 文件改动清单），蒸馏出的三段只能空洞。让 Claude 在 block 恢复后自己
 * 写文件，能拿满上下文产生高质量的决策审计条目。
 *
 * ## 防死循环
 *
 * stop_hook_active === true 表示上一轮已经触发过一次 Stop 阻断（恰好
 * 就是本脚本注入的 block），此时直接 continue 放行。配合 block reason
 * 末尾的「不要再说『任务完成』」，形成闭环。
 *
 * ## 依赖
 *
 * 零外部依赖。Node.js ≥ 14（CLI 自带的即可）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// 可调参数（若需要定制插件行为，改这里的常量即可）
// ═══════════════════════════════════════════════════════════════════

/**
 * 触发关键词。只匹配 assistant 末轮消息的落款位置，
 * 不会匹配句中出现的字面（见 isTriggerSignal 的两条规则）。
 */
const TRIGGER_PHRASE = '任务完成';

/**
 * 项目档案根目录(全局):每个项目以 sha1(cwd) 入档。
 * 结构:
 *   $HOME/.cai/projects/<hash>/path        // dir 绝对路径
 *   $HOME/.cai/projects/<hash>/history.md  // 三段式归档
 */
const PROJECT_ARCHIVE_ROOT = path.join(os.homedir(), '.cai', 'projects');

/** 归档文件名(位于 proj 目录下) */
const HISTORY_FILE = 'history.md';

/**
 * TRIGGER_PHRASE 之后的字符必须全部属于本正则，才判定为「位于末尾」。
 * 覆盖全角/半角标点与空白，防止 "任务完成了不少" 这类半截话误触发。
 */
const TAIL_ONLY_PUNCT_RE = /^[\s。．\.！!？\?、，,；;…\-—'"」』\)）\]\}*\*【】]*$/;

/**
 * 否定词窗口：标记出现位置的前 N 个字符内如果包含任何否定词，
 * 则视为 meta 引用（如 "避免说任务完成"），不予触发。
 */
const NEGATION_WINDOW = 8;

/**
 * 否定词列表。用 includes 做前向匹配，所以 "不要" 可同时挡住 "不要说"。
 */
const NEGATION_TOKENS = [
  '避免', '不要', '不能', '不会', '没有', '没', '别', '禁止', '勿',
  '不说', '不提', '不写', '不要再', '不再', '不能再', '请不',
];

// ═══════════════════════════════════════════════════════════════════
// 工具函数：I/O 与安全解析
// ═══════════════════════════════════════════════════════════════════

/**
 * 同步读取 stdin 的完整内容。Claude Code 通过管道传入当前 hook 上下文 JSON。
 * @returns {string} stdin 原始文本，读取失败返回空串
 */
function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

/**
 * 安全 JSON.parse：解析失败时返回 fallback，不抛异常。
 * @param {string} text
 * @param {*} fallback
 * @returns {*}
 */
function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

/**
 * 从 Claude Code transcript JSONL 文件中提取最后一条 assistant 消息的纯文本。
 *
 * Claude Code v2.1.170+ transcript 格式：一次 assistant 回复拆为多行
 * (thinking → text → tool_use),各行同 `message.id` 连续排列；
 * 旧版为单行 `{"role":"assistant","content":"…"}`。
 *
 * 本函数从文件末尾向前扫描,收集连续 assistant 行中同一 `message.id`
 * 的所有 text 块拼接后返回。这样即使最后一行是 tool_use(无 text),
 * 也能回溯到前面的 text 行命中触发词。
 *
 * @param {string} transcriptPath  transcript 文件路径（由 Claude Code 传入）
 * @returns {string} 最后一条 assistant 消息的文本内容；文件不存在或解析失败返回空串
 */
function readLastAssistantTextFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  let turnMessageId = null;
  const textChunks = [];

  // 从末行向上扫描,收集同 message.id 的连续 assistant 行的 text 块
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeJsonParse(lines[i], null);
    if (!obj) continue;

    const isAssistant =
      obj.type === 'assistant' ||
      obj.role === 'assistant' ||
      obj?.message?.role === 'assistant';
    // 非 assistant 行：若尚未收集到任何 assistant 内容，跳过尾随行继续向前扫描；
    // 若已收集到则 break（当前 turn 已完整）。
    if (!isAssistant) {
      if (turnMessageId === null) continue;
      break;
    }

    const msgId = obj?.message?.id ?? null;
    if (turnMessageId !== null && msgId !== turnMessageId) break;  // 不同 turn
    turnMessageId = msgId;

    // content 可能是 string、[{text}, {tool_use}, …]、或 {text:…}
    const content = obj?.message?.content ?? obj.content ?? '';
    if (typeof content === 'string') {
      textChunks.unshift(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const c of content) {
        const t = typeof c === 'string' ? c : c?.text ?? '';
        if (t) textChunks.unshift(t);
      }
    } else if (typeof content === 'object' && content?.text) {
      textChunks.unshift(String(content.text));
    }
  }
  return textChunks.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 任务 ID 生成
// ═══════════════════════════════════════════════════════════════════

/**
 * 返回本地日期字符串 `YYYY-MM-DD`。
 * @returns {string}
 */
function todayPrefix() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 在 `historyPath` 中扫描当日的最大 Txxx 编号，返回下一个可用 ID。
 *
 * ## 算法
 *
 * 用正则 `/^##\s+YYYY-MM-DD-T(\d+)/gm` 匹配所有 `## YYYY-MM-DD-Txxx`
 * 段头行，提取 T 后缀数字，取 max + 1。当日尚无条目时返回 T001。
 *
 * ## 并发风险
 *
 * 同一项目在同一秒内由两个 Claude Code 窗口同时触发 Stop hook 时，
 * 两个进程读到的 max 相同，会导致 Txxx 冲突。概率极低（需同秒同项目
 * 同时说"任务完成"），暂不引入文件锁，避免 I/O 复杂度。
 *
 * @param {string} historyPath  history.md 的绝对路径
 * @param {string} datePrefix  "YYYY-MM-DD"
 * @returns {string} "YYYY-MM-DD-Txxx" 格式的任务 ID
 */
function nextTaskId(historyPath, datePrefix) {
  let max = 0;
  if (fs.existsSync(historyPath)) {
    const text = fs.readFileSync(historyPath, 'utf8');
    const re = new RegExp(`^##\\s+${datePrefix.replace(/-/g, '\\-')}-T(\\d+)`, 'gm');
    for (const m of text.matchAll(re)) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${datePrefix}-T${String(max + 1).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════
// 插件根路径解析
// ═══════════════════════════════════════════════════════════════════

/**
 * 返回插件根目录，用于定位 `templates/aitask-entry.md`。
 *
 * Claude Code 在 hook command 执行前设置 CLAUDE_PLUGIN_ROOT 环境变量。
 * 若缺失（如手动测试），回退到脚本自身所在的 `../`（即 scripts/ → plugin root）。
 *
 * @returns {string} 插件根绝对路径
 */
function resolvePluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
}

/**
 * 计算项目档案路径。
 *
 * dir → hash = sha1(dir 绝对路径) → proj = $HOME/.cai/projects/<hash>/
 *
 * 副作用:确保 proj/ 存在,且 proj/path 文件内容为最新 dir 绝对路径。
 * 这两步是幂等的——session-start-hook 也会做,但 Stop hook 可能在
 * session-start 未运行前触发(例如 SessionStart 钩子被禁用),所以这里
 * 再做一次防御。
 *
 * @param {string} cwd  Claude Code 报告的当前工作目录
 * @returns {{ hash: string, projDir: string, historyPath: string }}
 */
function resolveProjectArchive(cwd) {
  const dir = path.resolve(cwd);
  const hash = crypto.createHash('sha1').update(dir).digest('hex');
  const projDir = path.join(PROJECT_ARCHIVE_ROOT, hash);
  const historyPath = path.join(projDir, HISTORY_FILE);
  try {
    fs.mkdirSync(projDir, { recursive: true });
    const pathFile = path.join(projDir, 'path');
    let current = '';
    try { current = fs.readFileSync(pathFile, 'utf8').trim(); } catch (_) { /* ignore */ }
    if (current !== dir) fs.writeFileSync(pathFile, dir + '\n');
  } catch (_) {
    // mkdir 失败一般是权限问题;不阻塞 hook,让上层放行。
  }
  return { hash, projDir, historyPath };
}

// ═══════════════════════════════════════════════════════════════════
// 触发判定
// ═══════════════════════════════════════════════════════════════════

/**
 * 判断末轮 assistant 文本是否发出了「任务完成」落款信号。
 *
 * ## 两条铁律（全部满足才算触发）
 *
 * 1. **末尾锚定** — TRIGGER_PHRASE 的最后一次出现之后，仅允许标点/空白。
 *    这避免了 "之前任务完成过，但现在还不行" 之类句中引用被误判。
 *    使用 `lastIndexOf` 而非 `indexOf`，确保处理 "任务完成…任务完成" 时
 *    匹配的是最后一次出现的合法性。
 *
 * 2. **否定词过滤** — TRIGGER_PHRASE 前 NEGATION_WINDOW 字符内不能含有
 *    否定/meta 引用词（如「避免」「不要」「请不要再说」）。
 *    这防止 "请不要再说任务完成" 这种元讨论触发。
 *
 * ## 注意
 *
 * - 判断只针对末轮 assistant 消息（readLastAssistantTextFromTranscript 已做）。
 * - 中段出现的"任务完成"不会影响触发——规则 1 的 lastIndexOf + 锚定自然排除了。
 *
 * @param {string} text  末轮 assistant 消息文本
 * @returns {boolean}  是否触发了落款信号
 */
function isTriggerSignal(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const idx = trimmed.lastIndexOf(TRIGGER_PHRASE);
  if (idx === -1) return false;

  // 铁律 1：末尾锚定
  const after = trimmed.slice(idx + TRIGGER_PHRASE.length);
  if (!TAIL_ONLY_PUNCT_RE.test(after)) return false;

  // 铁律 2：否定词过滤
  const beforeCtx = trimmed.slice(Math.max(0, idx - NEGATION_WINDOW), idx);
  for (const neg of NEGATION_TOKENS) {
    if (beforeCtx.includes(neg)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Hook 输出
// ═══════════════════════════════════════════════════════════════════

/**
 * 放行本轮，Hook 不干预 Claude 继续对话。
 * 输出 JSON: `{"continue":true,"suppressOutput":true}`
 */
function continueSilently() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

/**
 * 阻断本轮，要求 Claude 在下一条消息中执行 reason 中的指令。
 *
 * Claude Code Stop hook 约定：
 * - decision="block" → 阻断；reason 会在下一个 assistant turn 作为提示注入。
 * - 本脚本依赖这个机制实现「本脚本检测 → Claude 写文件」的两阶段分工。
 *
 * @param {string} reason  注入给 Claude 的指令文本
 */
function blockWithReason(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════

function main() {
  const stdin = readStdinSync();
  const input = safeJsonParse(stdin, {}) || {};

  // 防死循环：stop_hook_active === true 表示上一轮是 block，本脚本注入的
  // reason 刚刚被执行。此时必须放行，不能再检 transcript。
  if (input.stop_hook_active === true) return continueSilently();

  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path || '';
  const lastText = readLastAssistantTextFromTranscript(transcriptPath);

  if (!isTriggerSignal(lastText)) return continueSilently();

  // 落款命中：准备 block reason，让 Claude 来写归档文件。
  const datePrefix = todayPrefix();
  const { hash, historyPath } = resolveProjectArchive(cwd);
  const taskId = nextTaskId(historyPath, datePrefix);
  const templatePath = path.join(resolvePluginRoot(), 'templates', 'aitask-entry.md');

  const reason = [
    `检测到「${TRIGGER_PHRASE}」标志，触发 claude-task-history 归档流程。`,
    ``,
    `请按 ${templatePath} 的三段式模板，把本轮已完成任务追加到文件末尾：`,
    `  ${historyPath}`,
    `  (项目哈希 ${hash};对应 cwd: ${cwd})`,
    ``,
    `任务 ID 使用：${taskId}`,
    ``,
    `字段填写要求：`,
    `  - 标题：动宾结构、≤30 字、不带句号`,
    `  - 需求/问题：复述用户最原始诉求，1-2 句`,
    `  - 决策/方案：本次选了什么、为什么、放弃了什么；含关键 tradeoff`,
    `  - 验收/总结：实际做了什么、如何验证、踩坑/遗留、下次注意`,
    ``,
    `规则：`,
    `  - 仅追加新条目，禁止修改历史条目；若文件不存在则创建(目录已由 hook 预建)`,
    `  - 各段紧凑专业，反对流水账`,
    `  - 涉及代码改动尽量附 file:line 引用`,
    `  - 完成写入后**不要再说**「${TRIGGER_PHRASE}」，避免 Stop hook 二次触发`,
  ].join('\n');

  return blockWithReason(reason);
}

main();
