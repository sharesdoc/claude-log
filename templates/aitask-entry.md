<!--
四段式任务归档模板。

字段说明：
- {{TASK_ID}}     形如 2026-05-30-T001（YYYY-MM-DD-Txxx，Txxx 项目内当日自增）
- {{TITLE}}       一句话标题（动宾结构，≤30 字，不带句号）
- {{REQUEST}}     用户原话或最小复述，能让未来 reviewer 还原"为什么开干"
- {{DECISION}}    解决问题或实现需求所采用的具体方案、采用理由、注意事项和关键取舍
- {{ACCEPTANCE}}  实际完成情况、验证手段、踩坑/遗留、下次该注意什么
- {{RELATED_STANDARD_FILE}} 标准任务文件或标准问题文件的相对路径；多个文件用逗号分隔

写入规则：
- 仅追加新条目到 Stop hook reason 中给出的 historyPath（形如 $HOME/.cai/projects/<sha1(cwd)>/history.md）末尾，禁止改动历史条目
- 目录已由 hook 预建；若文件不存在则创建
- 各字段紧凑表述，每段 1-4 句，反对流水账
- 关联标准文件必须填写相对项目根目录的路径，如 `doc/Task-20260927120000000-P1.md` 或 `doc/Issue-20260927120000000-P1.md`；文件不存在或本任务未建立时，明确写"无（未建立标准任务/问题文件）"，禁止编造路径
- 涉及代码改动尽量给 file:line 引用
- 写完后**不要再说**"任务完成"，避免 Stop hook 二次触发
-->

## {{TASK_ID}}：{{TITLE}}

- **需求/问题**：{{REQUEST}}
- **决策/方案**：{{DECISION}}
- **验收/总结**：{{ACCEPTANCE}}
- **关联标准文件**：{{RELATED_STANDARD_FILE}}
