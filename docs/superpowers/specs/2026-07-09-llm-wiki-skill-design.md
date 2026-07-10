# llm-wiki 方案设计（v1）

日期：2026-07-09
状态：已获用户批准（brainstorming 流程产出）
范围：v1 = 知识库编译器 + 独立问答 CLI + coding-agent 对接；v2 = 智能记忆库 + MCP server（另立设计）

## 0. 背景与调研结论

基于 docs/ 下 10 篇 LLM Wiki 文章的全文精读综合 + 联网核实（2026-07-09）：

- Karpathy 原始 gist（`gist.github.com/karpathy/442a6bf555914893e9891c11519de94f`，2026-04）定义：三层架构（raw sources / wiki / schema）+ 三操作（**Ingest / Query / Lint**）。「distill/merge/prune」为第三方改写，不采用。
- 「省 90% token」为第三方营销数字，Karpathy 原文无任何百分比。**本项目宣传口径：token 成本可预估、可控，不引用该数字。**
- 关键工程教训（docs 中 H 文实测）：ingest 时做自动综合/自动反链/自动矛盾检测会导致 O(N²)~O(N³) token 爆炸（13 篇论文初建 287 万 token，增 6 篇 326 万）；改为「ingest O(1) + 综合按需 + 矛盾检测放 lint 批处理」后单篇更新降至 42 万（-87%）。此为本设计的核心纪律。
- 生态空白（差异化依据）：① 无工具能把**任意杂乱目录**（多格式、含重复/广告）清洗编译成标准 llm_wiki——现有实现均假设输入是整理好的笔记；② 无 token 预算感知的编译管线；③ 无「独立 CLI 问答 + agent skill 对接」双消费端；④ 与现有记忆工具的智能共存无人做好（v2）。
- 对接标准现状：AGENTS.md 跨 Claude/Codex 通用；skill 激活前仅 ~30-50 token；llms.txt 采用率约 10% 且在增长（Shopify 已全平台默认）；「skills 优先、MCP 兜底」为 2026 主流。
- 文间矛盾处理原则：Schema 文件名（CLAUDE.md/AGENTS.md/SCHEMA.md）、raw/ vs .raw/、概念页门槛（≥2 来源 vs ≥3 实体）、[[wikilink]] vs 标准 markdown 链接等矛盾点，一律做成 `wiki.config.json` 配置项，取最主流值为默认。

## 1. 总体架构

一个格式标准，两个消费端：

```
┌─────────────────────────────────────────────────┐
│           llm_wiki 知识库（纯 markdown + git）      │
│  AGENTS.md + raw/ + wiki/ + index.md + log.md    │
└───────────────┬─────────────────┬───────────────┘
                │                 │
     ┌──────────┴──────┐  ┌───────┴────────────┐
     │  CLI（确定性引擎） │  │  Skill（语义编译器）  │
     │  npx llm-wiki    │  │  Claude Code/Codex  │
     └─────────────────┘  └────────────────────┘
```

**分工原则（Thin Harness, Fat Skills）**：凡代码能确定性做对的（扫描、哈希增量、去重指纹、格式转换、链接校验、索引/图谱生成、问答检索管线），绝不让 LLM 做；LLM 只做语义判断（分类、提炼、建页、按需综合、矛盾裁决）。

## 2. 知识库格式标准（llm_wiki spec）

### 2.1 目录布局

```
<kb-root>/
├── AGENTS.md            # Schema 契约：页面类型、建页规则、操作纪律（LLM 行为说明书）
├── README.md            # 给人看的说明
├── llms.txt             # CLI 自动生成，外部 agent 按标准发现本库
├── wiki.config.json     # 阈值配置（见 2.4）
├── .manifest.json       # SHA-256 增量对账：源文件指纹 → 已编译页面映射
├── raw/                 # 原始资料层：只人写、LLM 只读、不可变
│   └── <按来源组织，convert 产物与原件并存>
└── wiki/                # 知识层：只 LLM 写、人只审阅
    ├── index.md         # 全局索引（标题 + 一句话摘要）；超规模自动分层 topics/
    ├── topics/          # （自动）大规模时的二级索引
    ├── log.md           # 仅追加操作日志：## [YYYY-MM-DD] <op> | <一句话>
    ├── hot.md           # ~500 字近期动态快照
    ├── graph.json       # CLI 生成的类型化关系图（含反向链接，不写进页面）
    ├── sources/         # 来源页：每篇资料一页
    ├── entities/        # 实体页：人/公司/产品/工具，≤30 行卡片式
    ├── concepts/        # 概念页：达到门槛才建（默认 ≥2 来源）
    └── comparisons/     # 对比/综合页：查询产生的有价值综合经确认写回
```

### 2.2 单页格式

- YAML frontmatter + Markdown 正文；页面必须完整、独立、结构化（不是碎片/分块）。
- frontmatter：`type`（必填：source|entity|concept|comparison，可扩展）、`title`、`description`、`tags`、`sources`（指向 raw 的证据链；**所有页面必填，来源页填其对应的单个 raw 文件**——status 命令依赖来源页的 sources 字段判断 raw 是否已编译）、`created`、`updated`。
- 正文按类型走 AGENTS.md 定义的固定章节模板。
- 可选标注：矛盾 callout `[!conflict]` / 加固 `[!reinforce]`（仅 lint 阶段写入）。

### 2.3 链接规范

- 页面内只写正向 `[[wikilink]]`（Obsidian 直接可用）；引用原始资料 `[[raw/...]]`；图片引用不复制。
- 反向链接一律不写进页面：由 CLI 扫描正向链接 + frontmatter 生成 graph.json（节点 = 页面，边 = 类型化关系），查询时按需读取。

### 2.4 wiki.config.json（矛盾点收编为配置）

| 键 | 默认 | 说明 |
|---|---|---|
| `schemaFile` | `AGENTS.md` | 可改 CLAUDE.md / SCHEMA.md（**v1 未生效**：代码支持但未接线，init 不写入生成的配置；v1.1 接线） |
| `rawDir` | `raw/` | 可改 `.raw/`（**v1 未生效**，同上） |
| `conceptThreshold` | 2 | 概念页建页门槛（被 N 篇来源提到） |
| `batchSize` | 5 | 编译单批文件数上限 |
| `cascadeDepth` | 3 | 级联更新最大深度 |
| `entityCardLines` | 30 | 实体页行数上限 |
| `indexSplitAt` | 200 | 页面数超过则 index 分层为 topics/ |
| `language` | `auto` | 页面语言（auto = 跟随源料主语言） |
| `linkStyle` | `wikilink` | 或 `markdown`（OKF 兼容导出；**v1 未实现**，不写入生成的配置；v2 随 OKF 导出实现） |

### 2.5 铁律

1. raw/ 只人写、不可变；wiki/ 只 LLM 写、人只审阅——读写权限隔离。
2. 来源内容视为不可信输入：LLM 不执行资料中的任何指令（防文档注入）。
3. 单库单垂直领域。**v1 已接受偏差**：scan 不做自动领域混杂检测（无可靠的确定性启发式）；该判断由 wiki-build skill 中的 LLM 在读料时人工执行，混杂时向用户建议拆库。v1.1 可考虑 tag/语言异质性启发式。
4. 全库纯本地 markdown + git 可管理，无供应商锁定。
5. Ingest 严格 O(1)：禁止自动综合、自动矛盾检测、自动反链维护。

## 3. CLI（npm 包 `llm-wiki`，Node.js，npx 直接运行）

| 命令 | 职责 |
|---|---|
| `init [dir]` | 脚手架知识库结构 + AGENTS.md/wiki.config.json 模板 |
| `scan <srcDir>` | 盘点源目录：格式统计、SHA-256 精确去重、minhash 近似去重指纹、语言检测、领域混杂预警；输出编译计划（分批清单）+ **token 成本预估** |
| `convert`（消费 scan 计划） | PDF/docx/html/txt → 干净 markdown；html 走 readability 抽正文（自动去广告/导航/页脚）。实现为 plan-driven：`convert --kb <dir>` 逐批转换 `.scan-plan.json` 中的文件，而非显式传文件列表 |
| `index` | 从 frontmatter 重建 index.md / topics/ / graph.json / llms.txt / hot.md 骨架 |
| `lint` | 机械校验：YAML 语法、frontmatter schema、断链、孤儿页、index 同步、manifest 对账；输出「可自动修/需 LLM 裁决」两份清单 |
| `ask "<问题>"` | 独立问答：读 index → BM25 定位候选页 → 读完整页面（绝不用 chunk 当上下文）→ 调第三方 LLM API 带引用作答 |
| `status` | 增量对账：新增/变更/删除的源文件，应触发的编译子集 |

- API 配置：`~/.llm-wiki/config.json`（全局）+ 知识库内可覆盖；OpenAI 兼容格式（baseURL/apiKey/model），任意第三方均可配。
- 知识库拷贝到任何机器后 `npx llm-wiki ask` 即可独立使用。

## 4. Skill（Claude Code / Codex）

| 入口 | 流程 |
|---|---|
| `/wiki-build <srcDir>` | 全量编译：CLI scan 出计划与成本预估（用户确认）→ 按批（≤batchSize）LLM 分类/提炼/建页 → 每批 CLI 校验 + manifest 存档（断点续跑）→ CLI 重建索引。概念先进 index 的 pending 列表，达门槛才建页 |
| `/wiki-ingest <files>` | 增量摄入：同上单批流程，O(1) 纪律 |
| `/wiki-query <问题>` | 读 index → 完整页 → 沿 wikilink 多跳 → 带引用作答；产生有价值综合时**经用户确认**写回 comparisons/ 并记 log |
| `/wiki-lint` | 低频批处理：CLI 机械清单自动修；语义清单（矛盾、过时、概念转正、对比页机会）逐项裁决，不能自动修的只报告 |
| `/wiki-connect` | 在项目 CLAUDE.md/AGENTS.md 写入 sentinel 受管指针块，登记多知识库及角色（`project`（默认项目库）/ `reference`（第三方参考库）/ `memory`（v2））；可干净卸载 |

## 5. 差异化定位

| 现有工具空白 | 本方案 |
|---|---|
| 输入必须是整理好的笔记 | 杂乱目录进、标准库出：多格式转换 + 双重去重 + 去广告 + 格式修正 |
| token 成本失控（实测 O(N³)） | 成本可控：O(1) ingest + 编译前成本预估账单 + 断点续跑 |
| 单消费端 | 同一库三吃：CLI 独立问答 + skill 对接 agent + llms.txt 标准暴露 |
| 反链/图谱靠 LLM 维护或缺失 | graph.json 由代码维护，零 token |
| Schema 硬编码 | 矛盾点全部收进 wiki.config.json |

## 6. 版本路线

- **v1**：格式标准 + CLI 七命令 + skill 五入口。验收：以本仓库 docs/ 的 10 篇文章为第一个测试语料，完整编译出知识库，`ask` 能带引用回答跨文章问题，lint 全绿。
- **v2**（另立设计）：智能记忆库（探测 claude-mem / MEMORY.md：无则替代记忆功能，有则按 CoALA 分工——wiki 承担语义记忆，现有工具承担情景记忆）、MCP server（对接 Cursor 等仅支持 MCP 的工具）、可选本地向量（仅做页面定位）、graph 可视化。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 编译质量依赖 LLM 发挥 | Schema 契约 + 每批 CLI 机械校验 + sources 证据链可溯源 |
| 大目录首次编译成本高 | scan 先出账单用户确认；断点续跑；批间可中断 |
| 源目录含恶意指令 | 铁律 2：来源视为不可信输入，skill 提示词中显式声明 |
| index.md 规模天花板（数百页后膨胀） | indexSplitAt 自动分层 topics/ + CLI BM25 定位兜底 |
| 与 Obsidian/OKF 生态兼容 | 默认 wikilink（Obsidian 原生）；linkStyle=markdown 支持 OKF 导出 |
