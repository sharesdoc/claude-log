#!/usr/bin/env node
/**
 * claude-task-history — SessionStart hook 脚本
 *
 * ## 设计目的
 *
 * Claude Code 每次启动/恢复/清屏新建 session 时触发 SessionStart hook。
 * 本脚本完成两件事:
 *
 *   1. 路径就绪:计算 hash = sha1(cwd),建立 $HOME/.cai/projects/<hash>/,
 *      写入 path 文件(项目绝对路径)。
 *   2. 静默注入近期历史:读取 proj/history.md 末尾 N 条任务条目(且发生在
 *      近 D 天内),通过 SessionStart 协议的 additionalContext 字段
 *      静默注入到本次 session 上下文(AI 可读,终端不可见)。
 *
 * ## 可配置(环境变量)
 *
 *   CLAUDE_TASK_HISTORY_RECENT_N      最多注入条数,默认 5
 *   CLAUDE_TASK_HISTORY_RECENT_DAYS   时间窗(天),默认 14
 *
 * ## 输入/输出协议
 *
 * stdin 是 Claude Code 传入的 JSON:
 *   { "hook_event_name": "SessionStart",
 *     "session_id": "...", "transcript_path": "...",
 *     "cwd": "...", "source": "startup|resume|clear" }
 *
 * stdout 必须是 JSON:
 *   { "continue": true,
 *     "hookSpecificOutput": {
 *       "hookEventName": "SessionStart",
 *       "additionalContext": "<注入文本>" } }
 *
 * 任意异常均静默放行(只输出 {"continue":true}),不阻塞用户。
 *
 * ## 依赖
 *
 * 零外部依赖,Node.js ≥ 14。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// 可调参数
// ═══════════════════════════════════════════════════════════════════

const PROJECT_ARCHIVE_ROOT = path.join(os.homedir(), '.cai', 'projects');
const HISTORY_FILE = 'history.md';

const DEFAULT_RECENT_N = 5;
const DEFAULT_RECENT_DAYS = 14;

// ═══════════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════════

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 静默放行(无注入)。Claude Code 视作 hook 完成,继续启动 session。
 */
function continueSilently() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

/**
 * 从任务条目正文中提取首行标题(## 行),截断以免过长。
 * @param {string} body  条目正文(含 ## 头)
 * @returns {string}  适合单行展示的摘要,如 "2026-06-14-T002:完善 claude-task-history…"
 */
function summarizeEntry(body) {
  const firstLine = body.split('\n')[0] || '';
  // 去掉 ## 前缀,保留日期-编号:标题
  const title = firstLine.replace(/^##\s+/, '').trim();
  // 截断到 72 字符,适配终端宽度
  return title.length > 72 ? title.slice(0, 69) + '…' : title;
}

/**
 * 注入上下文并放行(静默,不显示可见横幅)。
 *
 * 仅通过 additionalContext 注入系统提示词供 AI 读取,
 * 不在终端输出任何可见内容。
 *
 * @param {string}                ctx    要追加到 session 上下文的 markdown 片段
 * @param {Array<{date,body}>}    entries 用于生成摘要的条目列表
 */
function continueWithContext(ctx, entries) {
  const summaries = entries.map((e) => '> ' + summarizeEntry(e.body));
  const contextBanner = [
    '---',
    '',
    '## 📒 claude-task-history 已注入 ' + entries.length + ' 条近期任务',
    '',
    ...summaries,
    '',
    '---',
    '',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextBanner + '\n' + ctx,
    },
  }));
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════
// 项目档案就绪
// ═══════════════════════════════════════════════════════════════════

/**
 * 计算项目档案路径并保证 proj/、proj/path 就绪。
 * @param {string} cwd
 * @returns {{ hash: string, projDir: string, historyPath: string }}
 */
function ensureProjectArchive(cwd) {
  const dir = path.resolve(cwd);
  const hash = crypto.createHash('sha1').update(dir).digest('hex');
  const projDir = path.join(PROJECT_ARCHIVE_ROOT, hash);
  fs.mkdirSync(projDir, { recursive: true });
  const pathFile = path.join(projDir, 'path');
  let current = '';
  try { current = fs.readFileSync(pathFile, 'utf8').trim(); } catch (_) { /* ignore */ }
  if (current !== dir) fs.writeFileSync(pathFile, dir + '\n');
  const historyPath = path.join(projDir, HISTORY_FILE);
  return { hash, projDir, historyPath };
}

// ═══════════════════════════════════════════════════════════════════
// 抽取近期任务
// ═══════════════════════════════════════════════════════════════════

/**
 * 按 `## YYYY-MM-DD-Txxx[:...]` 段头切分 history.md,返回原始字符串数组。
 * 顺序与文件中相同(旧→新)。
 *
 * @param {string} text  history.md 全文
 * @returns {Array<{ date: string, body: string }>}  date 为段头识别出的日期
 */
function splitEntries(text) {
  const headRe = /^##\s+(\d{4}-\d{2}-\d{2})-T\d+/gm;
  const heads = [];
  for (const m of text.matchAll(headRe)) {
    heads.push({ date: m[1], start: m.index });
  }
  if (heads.length === 0) return [];
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].start;
    const end = i + 1 < heads.length ? heads[i + 1].start : text.length;
    out.push({ date: heads[i].date, body: text.slice(start, end).trim() });
  }
  return out;
}

/**
 * 取近期 N 条(且日期落在最近 D 天内)。倒序排列(新→旧)。
 *
 * @param {Array<{ date: string, body: string }>} entries
 * @param {number} n
 * @param {number} days
 * @returns {Array<{ date: string, body: string }>}
 */
function pickRecent(entries, n, days) {
  if (entries.length === 0) return [];
  // 计算窗口下限:今天往前 (days-1) 天的 YYYY-MM-DD
  const now = new Date();
  const lower = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const lowerStr = `${lower.getFullYear()}-${String(lower.getMonth() + 1).padStart(2, '0')}-${String(lower.getDate()).padStart(2, '0')}`;
  // 文件中天然按追加顺序,反转得到新→旧
  const reversed = entries.slice().reverse();
  const out = [];
  for (const e of reversed) {
    if (e.date < lowerStr) break;  // 已经超出时间窗,后面更旧,直接停
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════

function main() {
  const input = safeJsonParse(readStdinSync(), {}) || {};
  const cwd = input.cwd || process.cwd();

  let archive;
  try {
    archive = ensureProjectArchive(cwd);
  } catch (_) {
    return continueSilently();
  }

  if (!fs.existsSync(archive.historyPath)) return continueSilently();

  let text;
  try { text = fs.readFileSync(archive.historyPath, 'utf8'); } catch (_) { return continueSilently(); }

  const n = parsePositiveInt(process.env.CLAUDE_TASK_HISTORY_RECENT_N, DEFAULT_RECENT_N);
  const days = parsePositiveInt(process.env.CLAUDE_TASK_HISTORY_RECENT_DAYS, DEFAULT_RECENT_DAYS);
  const recent = pickRecent(splitEntries(text), n, days);
  if (recent.length === 0) return continueSilently();

  const header = [
    `# 📒 近期任务历史 (claude-task-history)`,
    ``,
    `项目路径: ${cwd}`,
    `归档位置: ${archive.historyPath}`,
    `注入策略: 最近 ${recent.length}/${n} 条(窗口 ${days} 天)`,
    ``,
    `> 以下为按时间倒序的最近任务条目,供本次 session 启动时参考上下文。`,
    `> 如需查看更多,使用 \`/his N\` (按天数回看)。`,
    ``,
    `---`,
    ``,
  ].join('\n');

  const body = recent.map((e) => e.body).join('\n\n');
  return continueWithContext(header + body + '\n', recent);
}

main();
