# 待裁定清单（pending rulings）

编译来源：docs/agent-briefs/diff-vs-upstream.md 交叉检查 (b)，沿用其 U 编号（U14/B3、B1/C2、U18、U1、第五项管理秘钥）。每条含：问题 / 规格文本位置 / 实现行为位置 / 上游对照 / 建议裁定方向。所有 file:line 均经逐条直接 Read/grep 核实。

---

## 1) U14/B3 — 429 冷却窗口语义互斥（spec 与上游冲突）

- 问题：本地 spec 与实现彼此一致，但与上游代码相反；属"待裁定"。
- 规格位置：spec/sections/S4-scheduling.md:126（"level increments at most once per still-open window"）。
- 实现位置：packages/core/src/scheduling/cooldown.ts:189-219（nextQuotaCooldown，steppedInWindow 在仍开启的窗口内升一级、且可能延长窗口）。
- 上游对照：（仓库外 _cpa_edge_ref）sdk/cliproxy/auth/conductor_cooldown.go:2256-2271（quotaCooldownAfterFailure 复用原窗口，不升级、不延长）。
- 建议方向：改 S4 文本 + cooldown.ts 对齐上游"不升级/不延长"，或在 SPEC §5 登记为刻意非等价（intentional non-equivalence）。注：S4 文本已与本地实现一致，冲突在 spec↔上游之间。五条里 parity 风险最高。

## 2) B1/C2（GR-4 伞下）— 401 门闩与 credential-scoped quota 跟 disable-cooling 的相互作用

- 问题：相互作用未钉定；且实现在 coolingEnabled 上有一处不一致。
- 规格位置：spec/sections/S4-scheduling.md:123（401/invalid_grant=unauthorized 表）、spec/sections/S4-scheduling.md:136（disable-cooling 优先级 + force 旁路）。
- 实现位置：packages/core/src/scheduling/cooldown.ts:518-526（401-class 把整条凭据锁 30 分钟，无论 disable-cooling——注释称其为"authorization fact"）；分支不一致在 packages/core/src/scheduling/cooldown.ts:475-496（credential-scoped quota 分支不使用 application.coolingEnabled，cooling 旁路只放在 model-scoped 分支 :506）——credential-scoped 429 在 cooling 关闭时照样设 quota，与 S4:136"timestamps zero…cleared"矛盾；model-scoped :506 则遵守。per-entry disable-cooling 在 node 归一化不收（runtimes/node/src/config.ts:206-232，diff-vs-upstream #54）。
- 上游对照：SPEC §5 GR-4 伞（SPEC.md:77）。
- 建议方向：在 spec 中钉定 401 门闩 + credential-quota-under-disable-cooling 的行为并配测试；决定 disable-cooling 端到端暴露还是维持 accepted-inert。

## 3) U18 — oai2oai 登记口径（已实现 merged:true 但无 S2d 专节、无合同、无 fixtures）

- 问题：方向已实现并 merged:true，但没有任何 S2d 小节、无合同测试、无 fixtures。
- 规格位置：无——SPEC.md Section registry :39-53 只列 S2d1..S2d10(passthrough)；SPEC.md 与 spec/sections/ 内 grep "oai2oai" 0 命中。
- 实现位置：runtimes/node/src/gateway.ts:186-195（'chat:openai-compatibility' → oai2oai，merged:true）；模块 packages/translators/src/oai2oai/{service,json,errors,sse}.ts；单元测试 packages/translators/src/oai2oai/unit.test.ts。tests/contract 有 s2d1–d9 文件但无 oai2oai；tests/fixtures 有 S2d1–S2d10 目录但无 oai2oai fixtures。
- 上游对照：审计报告 #13（分类 EDGE-ONLY）。注：diff-vs-upstream.md §4 的 U18 行本身是另一条过期占位说明（executors 占位注释）；oai2oai 条目是审计报告的 #13。
- 建议方向：补写一节 S2dX 并配 goldens，或在 SPEC §5 登记为刻意 EDGE-ONLY 偏差。

## 4) U1 / S6-file-adapter — S6:16 虚报 node 持久化

- 问题：S6 声称 node 保留 file adapter，但 node 默认是 MemoryStore（重启丢全部 auth/config）。SPEC.md 无持久化矩阵表述；DEPLOYMENT 实际已披露（见下），故矛盾仅在 S6:16。
- 规格位置：spec/sections/S6-state-storage.md:16（"runtimes/node keeps a file adapter; core only sees ConfigDocument"——grep 确认为 S6 中唯一 "file adapter" 行）。
- 实现位置：runtimes/node/src/gateway.ts:496（store = options.store ?? new MemoryStore()）；runtimes/node 无 file/git/pg 适配器。
- 上游对照：S6 §0 store-mapping 分歧（上游有 file/git/object/postgres 四后端）；审计项 U1 / #35。
- 建议方向：改 S6:16 反映 MemoryStore/重启丢失（改 spec——实现为真），或删除该声明。已修正行号：简报写 DEPLOYMENT:166，真实披露行是 docs/DEPLOYMENT.md:169（"process-local in-memory store (state does not survive restart)"）。

## 5) DEPLOYMENT 管理秘钥叙述 — env 键"常量时间比对 vs bcrypt 折线"

- 问题：简报引用 DEPLOYMENT.md:482，但 :482 是无关的 CLI --login 矩阵行；真正的表述是管理秘钥阶梯文本，且 env 键路径叙述与实际实现不符。
- 规格位置：docs/DEPLOYMENT.md:79-83（"MANAGEMENT_PASSWORD … compared constant-time"）；旁证 spec/sections/S3-auth-flows.md:89-90（env→常量时间、config→bcrypt）与 spec/sections/S6-state-storage.md:334。
- 实现位置：packages/auth/src/plane.ts:208-216（构建 managementConfig 只放 bcrypt 的 configSecret，envSecret/localSecret 未填充）；env 键在 runtimes/node/src/gateway.ts:503-506 读取 process.env.MANAGEMENT_PASSWORD 后在 plane.ts 之前被并入 secretKey，因此实际走 bcrypt。比对阶梯 packages/auth/src/mgmt-auth.ts:309-318（localSecret 常量时间 :310-311 → envSecret 常量时间 :313-314 → configSecret bcrypt :316-317，底层 mgmt-auth.ts:101-108 verifyManagementSecret）。
- 上游对照：R-BCRYPT（SPEC.md:69）/ S3-auth-flows.md §2.2 阶梯。
- 建议方向：改实现把 env 路由进 envSecret（令 env 真正常量时间，例如在 plane.ts 填充 managementConfig.envSecret），或改 docs/DEPLOYMENT.md:79-83 / S3:89-90 说明 env 被并入 bcrypt 的 config secret。

---

核实范围：以上每条的 file:line 均已直接读取源文件确认（含行号修正：DEPLOYMENT 实为 :79-83 与 :169 而非 :482/:166；S6 :16；cooldown.ts :189-219 / :475-496 / :518-526；上游 conductor_cooldown.go :2256-2271；oai2oai 的 gateway.ts :186-195 与 SPEC/S4 行位）。
