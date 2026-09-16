# 任务：CLIProxyAPI（上游参考）vs CPA-Edge（本项目）功能差别报告

## Role
你是独立的功能对齐审计员，工作目录 `/Users/gyue/projects/llm-api/cpa-edge`（TypeScript 单仓，`main` 分支）。
本仓库是上游 CLIProxyAPI 网关行为的 clean-room 重写，行为以录制的上游金样本为最终依据。
你不属于实现侧，本次只做比较与取证。

## Goal
回答一个问题并落成文件：**与参考项目 CLIProxyAPI 相比，本项目在功能上有哪些不同** —— 哪些一致、哪些缺失或降级、哪些形态不同、哪些是本项目新增。

## Success criteria（可观察，逐条自检）
1. 报告写入 `docs/agent-briefs/diff-vs-upstream.md`。这是本任务在仓库内唯一允许新建/修改的文件。
2. 每条差异都带双侧证据：上游给 `file:line` 或文档位置；本项目给 `file:line` 或 spec 小节 / 路由名。
3. 每条差异都打一个固定分类标签（见 Output），并与仓库自身的公开降级清单逐项对照，标明"已登记 / 未登记"。对照对象：`SPEC.md` §5（R-*、NE-*、GR-1..GR-8）与 `docs/DEPLOYMENT.md` §5。
4. 明确回答两个交叉问题：(a) 有没有"仓库自称缺失但实际可用"的条目；(b) 有没有"仓库自称已交付但实际不成立"的条目。若某类为空，写出你如何检查得以为空。
5. 报告结尾给出按影响排序的前 10 条差异。

## Evidence available
**本项目（可读，路径相对仓库根）**
- `SPEC.md` §5 —— 兼容裁定与刻意不等价登记表（R-404 / R-FIXTURE / R-SSE / R-BCRYPT / R-TOK / R-ORDER / R-SYNCREDS / R-EXECS / R-TRACE / NE-LENIENT / GR-1..GR-8）
- `docs/DEPLOYMENT.md` §5 —— 同一登记表的操作者措辞，含 §5.2 平台矩阵（node / cloudflare / vercel 三列）
- `STATUS.md` —— 步骤表与最终裁定日志；`reports/D2-FINAL-AUDIT.md` —— 上一次全局审计的结论（含 M1..M13 与"文档虚报"教训）
- `spec/sections/*.md` —— 16 个已准入模块规格（S1 端点面、S2d1..S2d10 翻译方向、S3 auth、S4 调度、S5 管理 API、S6 状态存储、S7 平台降级矩阵）
- 实现面：`packages/{core,translators,executors,auth,management}/src`、`runtimes/{node,cloudflare,vercel}/src`

**上游参考（只读，仓库外）**
`/Users/gyue/projects/llm-api/_cpa_edge_ref/CLIProxyAPI`
工作树干净，`HEAD = 8335eac731946bd4eff18f500653f93736df53d6`，`git describe` = `v7.3.4`，与本仓库 `SPEC.md` §0 的版本锚点是同一个提交。先跑一次这两个命令确认，再开工。
重点位置：`config.example.yaml`（约 58 KB，上游配置面最完整的清单）、`internal/`（`api`、`translator`、`auth`、`client`、`registry`、`runtime`、`store`、`thinking`、`signature`、`modelconfig`、`credentialweight`、`safemode`、`home`、`homeplugins`、`pluginhost`、`pluginstore`、`pluginapi`、`redisqueue`、`wsrelay`、`tui`、`discovery`、`watcher`、`managementasset`、`htmlsanitize`、`httpfetch`、`httpwire`、`cache`、`access`、`clienterror`、`logging`、`browser`、`buildinfo`）、`sdk/`、`cmd/`、`docs/`、`README.md`、`.github/`、`docker-compose*.yml`。

**校验命令（仓库根）**
`pnpm test`、`pnpm typecheck`、`pnpm lint`；单包 `pnpm --filter @cpa-edge/<name> typecheck`；单目录 `pnpm vitest run packages/<name>`。
上游侧：`SPEC.md` §0 记录源码构建需要 go 1.26。先确认本机 go 是否可用；不可用时上游一律以源码与文档取证，不要试图构建或运行上游。

**已知证据缺口**
没有可用的真实上游 OAuth 凭据，OAuth 供应商的真实响应内容无法本地复现。这类条目写进"未验证清单"并说明缺什么，不要用推断填补。

## Constraints
- 只读比较。除报告文件外不修改仓库任何文件；不碰 `tests/contract/**`、`tests/fixtures/**`、`SPEC.md`、`STATUS.md`、根配置；不执行 `pnpm add` / `npm install`；不向 `_cpa_edge_ref` 写入任何内容。
- 本任务属于规格侧角色，因此读上游源码是被允许的，但只作为规格参考：不得逐行改写成 TypeScript，不得复制注释或内部标识符（`AGENTS.md` 规则 1）。本次不交付代码 —— 不要顺手"改进"实现。
- 发现缺陷只登记，不修。发现你想重新设计或补充功能，写进报告的"待裁定"，不动手。
- 每条结论必须可追溯到具体文件与行号或路由名。无证据就写"未验证"，不要用本仓库文档的说法或常识填补。
- 本仓库自称的降级清单是**被审对象**：它可以作为对照项（判断某差异是否已登记），但不能作为行为证据。行为证据只能来自源码、路由名、测试或规格小节。
- 结论只在某个运行时成立时（node / cloudflare / vercel），按运行时分别给结论；不要把单运行结论写成全局结论。

## Tools
- 用 Python 或 `bash()` 做有目的的检索：先定位（上游路由注册点、`config.example.yaml` 的 key 清单、`internal/` 每个特性目录的入口），再精读命中区域；不要逐文件全量 cat。
- 独立读取并行发起；只有存在依赖关系时才串行。
- 某次检索为空或明显过窄时，换检索词或换一层目录再试 1–2 次，然后才允许下"上游没有此功能"的结论。
- 只有当一条差异需要运行时代码事实时才跑 `pnpm` 命令；纯源码比较不跑全量测试。

## Output
- 语言：中文。代码符号、路由、config key、JSON 字段名、文件名保持英文原样。
- 篇幅上限 400 行；每条差异只写一次，不要在多个小节重复。
- 结构：
  1. **结论**（≤150 字）：本项目相对上游的功能位置。
  2. **差异总表**：条目 | 上游行为 | 本项目行为 | 分类 | 运行时 | 是否已登记 | 双侧证据。
     分类只能取：`EQUIVALENT` / `DEGRADED` / `ABSENT` / `DIFFERENT-BY-DESIGN` / `EDGE-ONLY`。
  3. **分主题小节**（每个主题都要覆盖，无差异也要写一行"一致"）：
     协议与端点面 · 翻译方向矩阵 · 凭据与 OAuth 登录 · 调度与多账号轮换 · 管理 API · 状态与存储 · 运行时与平台差异 · 上游运维面（插件 ABI、TUI、home 集群、控制面板资源、pprof、mDNS/DNS-SD、文件日志、热重载与文件监听、代理出站、Redis-RESP 用量旁路、入站 WebSocket、Go SDK 嵌入式用法、C-ABI 插件） · 配置面（以 `config.example.yaml` 为清单逐项落地：本项目接受 / 忽略 / 无消费方 / 无此 key）。
  4. **未登记差异清单** —— 本项目实际行为与自身文档不一致的条目（第 4 条成功标准的落点）。
  5. **未验证清单** —— 条目 + 缺少的证据 + 需要什么才能验证。
  6. **前 10 条按影响排序**。

## Stop rules
- 9 个主题全部覆盖 + 两个交叉检查完成，即停。不追求对上游全仓做逐行 diff。
- 时间预算约 60 分钟。接近预算时优先保住：总表、未登记差异清单、前 10 条；主题小节可以精简。
- 需要越出只读边界的动作（装依赖、跑上游、改配置、访问外网）：不执行，写进"未验证清单"。
- 你的读取结论与仓库文档冲突且证据不足时：以你亲自读到的源码为准，同时注明文档现有说法，标为"待裁定"，不要自行改文档。
- 完成后：若你是以子代理身份被启动、存在 parent，则用 `await agent_message.send(summary, receiver_role='parent')` 回报；否则直接把报告路径作为最终回复。两种情况都写清：报告路径、条目总数（按分类计数）、你跑过的命令与结果、未验证项数量、以及第 4 条交叉检查的答案。
