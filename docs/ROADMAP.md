# llm-wiki Roadmap

状态基线：v1 已合并 main 并通过两轮审查（任务级 14 轮 + 全分支终审 + 发布前深审）。本文件是仓库内可跟踪的待办清单，取代 `.superpowers/sdd/progress.md`（gitignore 的临时台账）中的分级结论。

## v1.1（小修，无设计决策）

- [ ] convert：re-convert 已变更源文件时旧 raw 文件成为孤儿（`uniquePath` 写 `-2` 新文件，旧文件滞留）——需要清理归属设计：转换前按 manifest 旧条目删除/归档旧 raw
- [ ] convert：`_originals/<basename>` 同名不同目录源文件静默互覆——加碰撞后缀
- [ ] convert：`.scan-plan.json` 手工编辑/过期时 `byRel.get` undefined 抛裸 TypeError——友好报错
- [ ] convert/测试：txt 与 docx 分支无测试；失败路径（failed 不进 manifest）无断言
- [ ] scan：`--exclude` 路径无测试；空文件语言检测 NaN→en 属偶然正确——显式空守卫
- [ ] manifest：损坏 JSON 裸抛 SyntaxError——包一层带文件名的友好错误
- [ ] indexer：Pending 段贪婪匹配到 EOF，用户在其后加的段落会被吸收——限定段落边界
- [ ] indexer：>indexSplitAt 的 topics 分层路径无测试
- [ ] bm25：k 截断/score>0 过滤/空查询无测试
- [ ] ask：非预期 200 响应体裸 TypeError——校验 choices 形状；损坏 config.json 的 SyntaxError 可能在本机终端回显 key 片段——包错误
- [ ] lint：missing-field 规则在测试中从未触发；contradiction-scan 有产出但无断言
- [ ] connect：no-op remove 仍写空 `.llm-wiki.json`——与 CLAUDE.md 同样的守卫
- [ ] config 接线：`rawDir` / `schemaFile` 全链路生效（kbPaths 已支持，12 个调用点需传配置）

## v1.2（研究采纳，2026-07 深度调研驱动）

依据 2026-07-09 验证过的调研结论（STALE 55.2%、Nemori prediction-error 门控 +25%、
obsidian-wiki 竞品功能差、AAAI 2026 grep-agent ≈ 向量 RAG）：

- [x] 时间感知失效：frontmatter `status: invalidated` / `superseded_by`，lint 规则 + index 标注 + llms.txt/ask 排除（invalidate 而非 delete）
- [x] 溯源传播：`status --src` 报告变更/删除源影响的 wiki 页（manifest src→raw ⋈ 页面 sources raw→pages，纯推导零冗余）
- [x] lint `stale-scan`：raw 重编译晚于页面 updated → 语义工单
- [x] graph 导出：GraphML / Cypher / 自包含交互 HTML（`llm-wiki export`）
- [x] wiki-distill skill：情景记忆→语义页，prediction-error 门控 + raw/distilled/ 证据层

## v2（设计文档另立）

- [ ] MCP server：对接 Cursor 等仅支持 MCP 的工具
- [ ] `linkStyle: markdown`：OKF 兼容导出
- [ ] 可选本地向量（仅页面定位，绝不用 chunk 当上下文）
- [ ] scan 领域混杂启发式（tag/语言异质性）

## 已明确 wontfix（记录理由）

- 极小文本 jaccardEstimate NaN（`_sig` 已按长度门槛跳过，不可达）
- 目录名伪装 `*.md` 导致 EISDIR（病态输入）
- CJK 单字+bigram 令牌重复计数抬高 len（全库一致，排序公平）
- scan→convert 之间文件被改的哈希竞态（自愈：下轮重扫重编译）
