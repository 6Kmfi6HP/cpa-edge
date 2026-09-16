# CPA-Edge vs CLIProxyAPI v7.3.4 — 功能差别审计报告

- 审计日：2026-09-17。上游锚点已核验：`HEAD = 8335eac731946bd4eff18f500653f93736df53d6`，`git describe = v7.3.4`，工作树干净，与 SPEC.md §0 同一提交。本机 go 1.24.4 < 上游要求 1.26，上游未构建、未运行，全部以源码与文档取证。
- 本审计独立取证；仓库内既有的同名旧报告已被本版本替换。每条结论的双侧证据均为本次亲自读到的 file:line 或路由名。
- 分类五值：`EQUIVALENT` / `DEGRADED` / `ABSENT` / `DIFFERENT-BY-DESIGN` / `EDGE-ONLY`。"已登记"对照 SPEC.md §5（R-*/NE-*/GR-1..8）与 docs/DEPLOYMENT.md §5；"未登记"指两处均未点名。

## 1. 结论

CPA-Edge 在协议/路由面、入站鉴权、管理面路由存在性、10 个已合并翻译方向上与上游逐钉对齐；实质差距集中在已登记的 v1 降级（OAuth 不服务、antigravity 执行面、原生透传缝、调度引擎未接服务路径、node 五子项缺席）与若干未登记的实现缺口（usage 管线未接服务路径、reset-quota 不生效、4 对翻译方向缺席、node 无持久化）。

## 2. 差异总表

| # | 条目 | 上游行为 | 本项目行为 | 分类 | 运行时 | 是否已登记 | 双侧证据 |
|---|---|---|---|---|---|---|---|
| 1 | 客户端/公开路由全集（/v1 组、/v1beta、/backend-api/codex、/openai/v1/videos、realtime/live、回调×5、/、/healthz、/management.html、OPTIONS 204） | 全量注册 | 路径/方法/别名组一一对齐 | EQUIVALENT | 全部 | S1 §3 主表 | internal/api/server_routes.go:51-208；runtimes/node/src/router.ts:44-122 |
| 2 | R-404 平台语义（空体 404、404-not-405、尾斜杠 301/307） | gin 行为 | 逐句镜像 | EQUIVALENT | 全部 | R-404（SPEC.md:66） | router.ts:209-223 |
| 3 | Example-API-key safe mode（403 + X-Cpa-Safe-Mode、警告页、?safe-mode=configure 豁免） | 全量 | 平面实现等价 | EQUIVALENT | 全部 | S1-25（S1-endpoints.md:170-177） | internal/safemode/example_api_keys.go；packages/auth/src/plane.ts:185-239 |
| 4 | /keep-alive（仅 TUI/本地口令模式注册） | 条件注册 | keepAlivePassword 注入时注册，缺省 404 | EQUIVALENT | node（cf/vercel 无注入口=恒 404，与上游非 TUI 一致） | NE-S7-08（S7:596-598） | internal/api/server_keepalive.go:24；runtimes/node/src/gateway.ts:1100-1112 |
| 5 | 模型目录变体（?client_version= Codex 目录、grok-shell UA、Home 目录） | 5 支派 | 仅 default + claude 两形；注释明注不实现 | DEGRADED | 全部 | S1 §6.2 项 3-5 OPTIONAL/OQ-2/OQ-4（S1-endpoints.md:262-264） | server_routes.go:591-703；runtimes/node/src/gateway.ts:1167-1184 |
| 6 | images/videos/alpha-search/live/realtime 转发面 | 真实派发（xAI videos、codex live SDP 中继等） | 统一 503 not_implemented 缝；realtime 的 client_secrets/sessions 本地 mint 200（成功体未钉）、SIP/transcription/translations 501 stub 与上游同形 | DEGRADED | 全部 | GR-1/GR-2/GR-3/R-EXECS（SPEC.md:74-84） | sdk/api/handlers/openai/openai_images_handlers.go、internal/client/codex/live/*；gateway.ts:178-251、1356-1399 |
| 7 | GET /v1/ws（wsrelay：Gemini 请求经 WS 桥接给客户端） | 真实 relay | node：ws-auth 门等价，101 后接受即关（无 relay）；cf：DO hibernation 静默持有；vercel：auth 门后 501 | DEGRADED | 分列 | S7 F4（S7:189）+ NE-S7-07 + DEPLOYMENT:481"relay 属 executor 领域"注 | internal/wsrelay/manager.go:17-20；gateway.ts:1340-1355,1458-1467；runtimes/cloudflare/src/gateway.ts:986-1009；runtimes/vercel/src/degradations.ts:44-46 |
| 8 | 10 个已合并翻译方向（oai2gem/gem2oai/oai2cla/cla2oai/oai2codex/res2oai/gem2cla/cla2gem/codex-passthrough/oai2oai） | 对应注册全实现 | 全 merged，金档钉住（oai2oai 除外见 #13） | EQUIVALENT | 全部 | STATUS.md I-tr 各行 | internal/translator/**/init.go（30 注册）；packages/translators/src/*；gateway.ts:178-247 DIRECTIONS |
| 9 | cla2codex、gem2codex、res2gem、res2cla 四对翻译 | 实体注册（Claude→Codex、Gemini→Codex、Responses→Gemini、Responses→Claude） | 无模块、无 DIRECTIONS 条目 → 503 缝 | ABSENT | 全部 | 未登记（GR-3 仅点名 cla2cla/gem2gem/xai/meta/interactions/vertex，未列此四对） | internal/translator/codex/claude/init.go:10-17、codex/gemini/init.go、gemini/openai/responses/init.go:10-16、claude/openai/responses/init.go:10-16；gateway.ts:178-251 |
| 10 | antigravity 翻译+执行平面（5 注册 + executor wire） | 全实现 | 无模块（grep 0 命中）；18 goldens 已录未实现 | ABSENT | 全部（凭据可登录/列/刷新） | GR-2（SPEC.md:75） | internal/translator/antigravity/*/init.go；packages/translators/src 无 antigravity |
| 11 | interactions 平面（11 注册：双向含 claude/gemini/codex/antigravity/openai） | 全实现 | 仅 /v1beta/interactions 端点+校验；native wire 与翻译 503 | ABSENT | 全部 | 部分登记（R-EXECS 尾句 SPEC.md:84 点名 interactions native wire；翻译矩阵侧未点名） | internal/translator/*/interactions/init.go；S1 §3.4；gateway.ts DIRECTIONS |
| 12 | cla2cla、gem2gem 原生透传 | 规范化/透传注册 | 503 登记缝（merged:false） | DEGRADED | 全部 | GR-3（SPEC.md:76） | internal/translator/gemini/gemini/init.go:12-19；gateway.ts:196-201,236-242 |
| 13 | oai2oai（chat 薄规范化） | 有实现 | 已实现且接入服务路径，但无专属 spec 小节、tests/contract 无专节 | EDGE-ONLY | 全部 | 部分登记（D2-FINAL-AUDIT unpinned-but-implemented 口径；SPEC §5 无条） | internal/translator/openai/openai/chat-completions/init.go:10-16；packages/translators/src/oai2oai/；tests/contract 目录无 s2d4/oai2oai 文件 |
| 14 | OAuth 凭据服务（CLI 订阅模型映射到客户端请求） | 全供应商可服务 | v1 仅 API-KEY 家族进注册表；OAuth-only 模型 400 model_not_found | ABSENT（v1） | 全部 | GR-1（SPEC.md:74） | internal/registry/model_registry.go；runtimes/node/src/config.ts:27-38 FAMILY_ORDER、registry.ts:1-10 |
| 15 | 入站 api-key 鉴权 + 管理鉴权管线（bcrypt 首启回写、5 连败 30min ban、XFF、ek_ 临时 secret） | 全量 | 等价复刻 | EQUIVALENT | 全部 | R-BCRYPT（SPEC.md:69）+ S3 | sdk/access/errors.go、internal/api/handlers/management/handler.go；packages/auth/src/api-keys.ts、mgmt-auth.ts、realtime.ts |
| 16 | OAuth code/device 流包层 wire（authorize URL、exchange、回调 HTML、会话 TTL） | 全量 | 包层等价（7 供应商：anthropic/codex/antigravity/devin/kimi/xai/meta）；vendor 真实响应未验证 | EQUIVALENT（包层） | 全部 | R-FIXTURE CREDENTIALED-ONLY（SPEC.md:67） | internal/auth/*、sdk/auth/*；packages/auth/src/providers.ts:8-146、oauth-login.ts、token-exchange.ts、device-flows.ts、oauth-callback.ts |
| 17 | device flow 轮询驱动（xai/meta/kimi） | 进程内轮询直至完成 | node：envelope-only 无驱动；cf：DO alarm 驱动（live）；vercel：envelope-only 永不完成 | DEGRADED | 分列 | GR-5（SPEC.md:78）+ NE-S7-11 + DEPLOYMENT:479 | internal/auth/kimi/kimi.go；packages/auth/src/device-flows.ts；runtimes/cloudflare/src/alarm.ts、gateway.ts:1041-1090 |
| 18 | 后台 token 刷新驱动 + refresh-on-401 | 常驻 goroutine | node/vercel：仅手动 POST /auth-files/refresh；cf：DO alarm 驱动 | DEGRADED | 分列 | GR-5 + DEPLOYMENT:480 | sdk/cliproxy/auth/conductor_refresh.go；packages/auth/src/refresh.ts；runtimes/cloudflare/src/alarm.ts:1-14,219-327 |
| 19 | CLI 登录面（8 个 *-login flag、browser/no-browser、loopback forwarder、vertex-import flag、TUI） | 全量 | 无 CLI 包（库形态）；loopback forwarder 缺席，手动 oauth-callback 中继 | ABSENT | 全部 | S7 F5d（S7:191）+ GR-5 loopback 子项 + DEPLOYMENT:118-119 | cmd/server/main.go:134-158；runtimes/node 无 CLI 入口 |
| 20 | Codex 档持久键 plan_type（code flow） | 仅 device flow 经 metadata 注入 plan_type；code flow 结构体无此键 | code flow exchangeCodexCode 写 document.plan_type | EDGE-ONLY | 全部 | 未登记 | internal/auth/codex/token.go:18-39、sdk/auth/codex_device.go:291；packages/auth/src/token-exchange.ts:190,244 |
| 21 | 调度策略引擎（RR/smooth-WRR/fill-first/priority/session-affinity/WS 偏好） | selector 全实现 | core 等价复刻+录制链单测；但 v1 服务路径 = config-order first-fit + facade 冷却 + retry 轮换，策略开关 echo-only | EQUIVALENT（引擎）+ DEGRADED（服务路径） | 全部 | GR-4（SPEC.md:77）+ DEPLOYMENT:515-525 | sdk/cliproxy/auth/selector.go；packages/core/src/scheduling/strategy.ts:14-35、scheduler.ts:1-16 |
| 22 | 429 quota 冷却窗内语义 | 窗内失败复用原窗口：不升级、不延长（quotaCooldownAfterFailure） | 窗内首次失败升级一级（steppedInWindow）且可能延长窗口；实现跟 S4 文本，S4 文本与上游代码相反 | DEGRADED（待裁定） | 全部 | 未登记 | sdk/cliproxy/auth/conductor_cooldown.go:2256-2271；packages/core/src/scheduling/cooldown.ts:189-219；S4-scheduling.md:126 |
| 23 | POST /reset-quota 清除冷却立即可调度 | authManager.ResetQuota 清 per-model 与凭据级状态；S4-07 金档录制"reset 后立即再服务" | handler 只回 200 {status:ok}，不调任何 cooldown 重置 | DEGRADED | 全部 | 未登记（GR-4 未列） | internal/api/handlers/management/quota.go:26-53；S4-scheduling.md:168,299；packages/management/src/api.ts:1807-1816 |
| 24 | quota signals 响应头被动观察（claude/codex/devin） | ObserveResponseHeaders 每结果采集 | 无 signals 字段；auth-files 列表 quota.signals 恒空 | ABSENT | 全部 | 未登记 | sdk/cliproxy/auth/quota_signals.go:14-23；packages/core/src/scheduling/cooldown.ts:46-55 |
| 25 | 游标/WRR 容量上限重置（rotation map 满限整表清、smooth-WRR 越界 prune） | ensureRotationKey/pruneStale | 无容量重置逻辑 | ABSENT（低危 corner） | 全部 | 未登记 | sdk/cliproxy/auth/selector.go:654-660,730-748；packages/core/src/scheduling/ 无 4096/1024 对应 |
| 26 | 管理面 ~146 路由存在性/阶梯 | gin 静态注册 | 通配 + 内部 dispatch 全数承接 | EQUIVALENT（载体 DIFFERENT-BY-DESIGN 不可观察） | 全部 | S5 全表 | internal/api/server_management.go:24-198；packages/management/src/api.ts:540-736 |
| 27 | GET /latest-version 实查 GitHub | 200 {"latest-version":tag} 或 502 家族 | 恒 500 {"error":"failed to fetch latest version"} | DEGRADED | 全部 | 部分登记（S5:80 EXTERNAL/FIXTURE-DEFERRED；恒 500 vs 502 形状差未登记） | internal/api/handlers/management/config_basic.go GetLatestVersion；packages/management/src/api.ts:608-611 |
| 28 | oauth-maps（excluded-models/model-alias/request-scoped-errors）PATCH/PUT/DELETE 校验阶梯 | 400 invalid provider、404 provider/channel not found | PATCH 恒 200 ok（空列删键无 404）；DELETE 仅 channel not found；无 invalid provider 400 | DEGRADED | 全部 | 未登记（S5:130-132 写了 404 家族未落实） | internal/api/handlers/management/config_lists.go:1139,1145-1177,1239-1274；packages/management/src/api.ts:1313-1390 |
| 29 | POST /api-call 的 auth_index + $TOKEN$ 替换（header/data） | 全实现 | 无 auth_index 读取、无 $TOKEN$ 替换；校验/UA/响应形等价 | DEGRADED | 全部 | 未登记（S5 §2.3 有 $TOKEN$ 语义） | internal/api/handlers/management/api_tools.go:32-34,161-185；packages/management/src/api.ts:1866-1920 |
| 30 | usage 统计管线（请求完成即入队 + recent_requests 计数 + usage-statistics-enabled 真开关） | redisqueue 内存队列，toggle 真实控制入队 | 任何运行时的服务路径均不调 recordUsage；usage-queue 恒空；api-key-usage 恒 0；toggle echo-only | DEGRADED | 全部 | 未登记（F8 仅登记 RESP listener 缺席；DEPLOYMENT:485"usage-queue HTTP keeps semantics"与实际相反） | internal/redisqueue/queue.go、usage_toggle.go:5-16；packages/management/src/api.ts:797-802,1986-1995、usage.ts:293-305；runtimes/{node,cloudflare}/src grep recordUsage 0 命中 |
| 31 | quota 端点族（providers/fetch/reset） | 插件宿主存在时有真实提供者 | providers 恒 []；fetch/reset 对已解析 auth 回 501（无插件宿主对应体） | DEGRADED | 全部 | 已登记（S5:155-157 + S7 F2 伞） | server_management.go:83-85；packages/management/src/api.ts:653-661,1789-1805 |
| 32 | 插件管理族 + plugin-store install | 全功能 + 商店安装 | GET /plugins 恒 plugins:[]；plugin-store 全路由 facade 500 handler unavailable；vercel/cf 对 install 包装为 501 F2 体，node 不包装（install 得 500） | DEGRADED | 分列（node install 500 vs S7 钉 501 未登记） | 部分登记（NE-S7-02 install 501 S7:247,498；node 500 偏差未登记） | server_management.go:34-45；packages/management/src/api.ts:686-700；runtimes/cloudflare/src/gateway.ts:1104-1112；runtimes/vercel/src/degradations.ts:279-289 |
| 33 | logs 端点族（文件扫描/cursor/下载 + 每请求错误 dump error-*.log） | 真文件底座；错误 dump 即使 logging-to-file:false 也写 | node/cf：Store ring 服务 /logs，ring 仅管理面事件喂入；request-error-logs 恒 {"files":[]}；vercel：501 | DEGRADED | 分列 | 部分登记（F3/NE-S7-03 + OQ-S7-02 路由形；node/cf 恒空未登记，且 OQ-S7-02 称 cf 经 DO 持久 dump 与实现不符） | internal/logging/*；packages/management/src/api.ts:669-677,518-522；runtimes/vercel/src/degradations.ts:249-267 |
| 34 | OAuth 管理会话族（*-auth-url×7/get-auth-status/oauth-session） | 全量 | node 全；cf：redirect 4 家 501、device 3 家 alarm；vercel：redirect 501 + device envelope-only | EQUIVALENT（node）/DEGRADED（cf/vercel） | 分列 | S7 F5a/F5b/F5c + NE-S7-05/NE-S7-11；vendor 成功路径未验证 | server_management.go:190-198；packages/auth/src/plane.ts:138-140；runtimes/cloudflare/src/gateway.ts:1040-1090 |
| 35 | Store seam 与后端矩阵（file/git/S3-object/Postgres 四后端 + auth-dir 文件持久） | 四选一 + 文件持久 | Store 抽象 3 实现：node=MemoryStore（默认，重启全失）、cf=DO、vercel=KV；无 file/git/pg 适配器 | DIFFERENT-BY-DESIGN（抽象）+ ABSENT（file/git/pg 后端） | 分列 | 部分登记（S6 §0 介质分歧；S6 §0:16"runtimes/node keeps a file adapter"与实现相反；git/pg/object 未单列） | internal/store/{gitstore,postgresstore,objectstore}.go、cmd/server/main.go:439-577；packages/core/src/store.ts、store-memory.ts；runtimes/node/src/gateway.ts:496 |
| 36 | config.yaml 热载 + 文件监听（fsnotify、sha256 门、debounce 150ms） | watcher 全实现 | node：无 fs、无 watcher、管理写接受+echo 但运行组合不变；cf/vercel：仅管理写 | ABSENT（node 热载）/DEGRADED（cf/vercel） | 分列 | GR-5 + NE-S7-06 + S6 B22（S6:335 为 MUST 文本，被 GR-5 覆盖） | internal/watcher/config_reload.go；runtimes/node/src 无 fs（grep node:fs/writeFile 0 命中） |
| 37 | usage 队列重启存活 | 纯内存，重启全失 | DO/KV 持久：过期未辞退记录重启后仍可取回 | DIFFERENT-BY-DESIGN（行为新增） | cf/vercel（node 等价） | 未登记 | internal/redisqueue/queue.go:24-37；runtimes/cloudflare/src/do-store.ts:8-30、runtimes/vercel/src/kv-store.ts:8-30 |
| 38 | 更新一致性（tmp+rename 原子写 vs CAS） | 原子文件写 | node CAS；DO 串行段；KV 乐观 CAS 跨键非原子 | DIFFERENT-BY-DESIGN | 分列 | 已登记（S6 §0:29-32） | internal/store/objectstore.go；runtimes/vercel/src/kv-store.ts:8-18 |
| 39 | node 五 REGISTERED ABSENT 子项（proxy 拨号、TLS listener、热载重组、后台刷新、device 轮询、loopback forwarder、文件日志衬底） | 全有 | 配置收+echo，行为缺席 | ABSENT | node | GR-5（SPEC.md:78）+ DEPLOYMENT:474-485 逐行 | sdk/proxyutil/proxy.go、internal/api/mux_listener.go；runtimes/node/src/server.ts:1-12（仅 node:http）、config.ts 不收 proxy-url/tls |
| 40 | capabilities 描述符 vs 审计现实 | — | NODE_RUNTIME_CAPABILITIES 声明 proxyTransport/fileLogging/fileWatching/localCallbackServer 全 true，与 GR-5/DEPLOYMENT §5.2 node 列 REGISTERED ABSENT 矛盾；node 代码不消费这些标志 | EDGE-ONLY（内部矛盾） | node | 未登记（DEPLOYMENT:466-469 声明 node 列为审计现实，但 capabilities 常量未改） | packages/core/src/capabilities.ts:32-41；SPEC.md:78；runtimes grep capabilities.proxyTransport 仅 cloudflare 命中 |
| 41 | 环境代理（proxy-url 空=inherit 走 HTTP(S)_PROXY） | ProxyFromEnvironment | 全运行时忽略环境代理 | DEGRADED | 全部 | NE-S7-04（DEPLOYMENT:501-506） | Go 默认 transport；S7:589-594 |
| 42 | 出站代理（显式 proxy-url 拨号） | 全 scheme 拨号 | node：不收 proxy-url、不拨号（无 fail-closed）；cf/vercel：代理凭据排除 + 无合格者 501 fail-closed | ABSENT（node 拨号）/DEGRADED（cf/vercel） | 分列 | GR-5（node）+ NE-S7-01（cf/vercel）；node"无 fail-closed strip"与 S7 F1 node=EQUIVALENT 旧矩阵矛盾已由 DEPLOYMENT:474 覆盖 | sdk/proxyutil/proxy.go；runtimes/cloudflare/src/gateway.ts:662-704 |
| 43 | vercel 流边界（maxDuration 预算用尽 → 家族终帧、无 [DONE]） | 无此限制 | boundary 预算制 + 家族自有终帧 | DIFFERENT-BY-DESIGN | vercel | 已登记（DEPLOYMENT:331-358） | runtimes/vercel/src/boundary.ts:1-35 |
| 44 | client IP 信任来源 | gin 默认信任 XFF | node=socket 地址；cf=cf-connecting-ip；vercel=不传 | DIFFERENT-BY-DESIGN | 分列 | DEPLOYMENT §1.2 区 | internal/api/server_middleware.go；runtimes/node/src/server.ts:70-73；runtimes/cloudflare/src/runtime.ts:236 |
| 45 | Home 集群（-home-jwt 成员、心跳门、插件分发、homeplugins 同步） | 全量 | 无任何 Home 状态机（上游 Home 亦非 config key，yaml:"-"，纯 CLI flag 面） | ABSENT | 全部 | 部分登记（S7:201-203 仅点名 cf/vercel ABSENT；node 同样缺席未点名） | internal/home/client.go、internal/homeplugins/sync.go、internal/config/config.go:20；本仓库 grep home 状态机 0 命中 |
| 46 | TUI 模式（dashboard/auth/keys/config tabs、i18n、10s idle 看门狗） | 全量 | 无 | ABSENT | 全部 | NE-S7-08（DEPLOYMENT:492-499） | internal/tui/app.go；全仓无对应 |
| 47 | pprof 诊断 listener（默认 127.0.0.1:8316） | pprof.enable 启动独立 listener | 无；键收而忽略 | ABSENT | 全部 | NE-S7-08 | sdk/cliproxy/pprof_server.go；config.example.yaml:48-50 |
| 48 | mDNS/DNS-SD 发现（_ai-gateway._tcp 广播 + discover CLI） | 全量 | 无；键收而忽略 | ABSENT | 全部 | NE-S7-08 | internal/discovery/zeroconf.go、cmd/server/main.go:144-149 |
| 49 | 管理控制面板（GitHub 资产下载 + 3h 后台更新 + htmlsanitize） | managementasset 自动下载链 | node：managementPanelHtml 注入式（无资产→404 空体，与上游 asset-missing 同形）；cf/vercel：恒 404 | DIFFERENT-BY-DESIGN（node 注入式）/DEGRADED（cf/vercel） | 分列 | 部分登记（S7 §2.2 仅 cf/vercel；node 注入式供给方式未登记） | internal/managementasset/updater.go；runtimes/node/src/gateway.ts:1088-1099 |
| 50 | Redis-RESP 用量旁路（主端口协议复用器，SUBSCRIBE usage/errors） | 同 TCP 端口 RESP/HTTP 分流 | 协议状态机在 management 包（harness 钉住）；三运行时无一绑 TCP listener | ABSENT（listener） | 全部 | S7 F8 + NE-S7-10 + DEPLOYMENT:485 | internal/api/protocol_multiplexer.go、redis_queue_protocol.go；packages/management/src/resp.ts:1-35；runtimes grep listener 0 命中 |
| 51 | C-ABI 插件宿主（dlopen + JSON-RPC schema v6 + 拦截器/执行器/鉴权适配器） | 全量 | 无 FFI；配置/管理面兼容形 registered:false | ABSENT | 全部 | NE-S7-02（S7:237-252） | sdk/pluginabi/types.go:4-30、internal/pluginhost/abi.go |
| 52 | internal/cache 族（BoundedLRU + signature/reasoning-replay 缓存×6） | 6 个缓存实现 | 全仓无对应（grep 0 命中） | ABSENT | 全部 | 未登记（S2d10 签名缓存配置键在 S6:318 有 schema 而无实现） | internal/cache/bounded_lru.go 等；packages+runtimes grep LRU/replay/signature cache 0 命中 |
| 53 | commercial-mode、passthrough-headers 真开关 | 前者关请求日志中间件、后者转发上游响应头 | 均仅管理面视图解析+echo，无运行时消费方 | DEGRADED（accepted-inert） | 全部 | 未登记（GR-6 清单未点名此二键） | internal/config/config.go:46-47、internal/api/server.go:148、sdk/api/handlers/handlers.go:190-192；packages/management/src/config.ts:492,508 |
| 54 | 供应商条目级键（weight、prefix、per-entry disable-cooling、per-entry request-retry、request-scoped-errors、excluded-models） | 全消费（权重/前缀路由/逐凭据覆盖） | node 归一化不收（静默忽略）；管理面接受 | DEGRADED（accepted-inert） | 全部 | 部分登记（weight/strategy 归 GR-4；request-scoped-errors 归 GR-6；prefix/per-entry retry 未点名） | config.example.yaml:418-422,448；runtimes/node/src/config.ts:206-232 |
| 55 | Go SDK 嵌入式用法（sdk/cliproxy + docs/sdk-*.md：builder/watcher/access/plugin 宿主） | 库嵌入 + 文档 | 本项目为 TS 库形态（createNodeGateway 组合面），无 watcher/access 等价 | DIFFERENT-BY-DESIGN | node | DEPLOYMENT:118-119 库形态声明 | sdk/cliproxy/builder.go、docs/sdk-usage.md；DEPLOYMENT §2.2 |
| 56 | 分发面（Dockerfile、docker-compose×2、examples×5、CI workflows、cmd/fetch_* 工具） | 全量 | 无（仓库无 Dockerfile/compose/examples） | ABSENT | — | 未登记（分发面非运行行为） | 上游根目录 Dockerfile/docker-compose.yml/examples/；cpa-edge 根目录 ls 无对应 |
| 57 | 配置面总账（config.example.yaml 全部 key 四类标签） | 47+ 顶层键 | 消费 23 键 + 8 provider 块；~25 键 accepted-inert；平台 ABSENT 若干；5 键 raw-only 未建模 | 混合 | 分列 | GR-6 伞 + S6 §3.1 逐条；raw-only 五键缺席未点名 | config.example.yaml；runtimes/node/src/config.ts:105,236-262；packages/management/src/config.ts |

## 3. 分主题小节

### 3.1 协议与端点面
一致为主：总表 #1/#2/#3/#4。DEGRADED 四处：目录变体（#5）、转发面缝（#6）、/v1/ws relay（#7）、模型 catalog 变体（#5 内）。缝体统一 503 `direction not yet available in this build`（gateway.ts:249-251），GR-3 显式 supersede R-EXECS 的 501 措辞。realtime 面除 relay 外与上游同形（SIP/transcription/translations 上游本身即 501 stub，本地镜像；client_secrets/sessions 本地 mint 200，成功体上游未钉、S1 §3.7 明注）。

### 3.2 翻译方向矩阵
上游 30 注册（internal/translator/**/init.go）对 5 客户端协议 × 6 上游协议。本项目合并 10 向（#8）；缺 4 对交叉方向（#9，未登记）；antigravity 5 注册（#10，GR-2）与 interactions 11 注册（#11，部分登记）整体缺席；cla2cla/gem2gem 原生透传 503 缝（#12，GR-3）；oai2oai 实现但无专属合同（#13）。

### 3.3 凭据与 OAuth 登录
包层 wire 等价（#15/#16，vendor 真实响应全部未验证见 §5）。服务面：OAuth 凭据 v1 不服务（#14，GR-1）。运行时驱动降级：device 轮询（#17）、后台刷新（#18）。CLI 登录面整体缺席（#19）。EDGE-ONLY：codex plan_type code-flow 持久键（#20，未登记——上游 code flow 结构体 internal/auth/codex/token.go:18-39 无 plan_type，仅 device flow 经 metadata 注入 sdk/auth/codex_device.go:291）。

### 3.4 调度与多账号轮换
引擎等价（#21，GR-4 伞：服务路径 first-fit）。未登记三缺口：429 窗内语义与上游代码相反（#22——上游 conductor_cooldown.go:2256-2271 窗内复用不升级；本地 cooldown.ts:199-205 窗内升一级；S4:126 文本跟本地）；reset-quota 不清状态（#23——S4-07 金档承诺立即可调度）；quota signals 缺席（#24）。低危 corner：容量重置（#25）。

### 3.5 管理 API
存在性/阶梯等价（#26）。DEGRADED：latest-version 恒 500（#27）、oauth-maps PATCH 恒 200（#28，S5:130-132 文本未落实）、api-call 无 $TOKEN$/auth_index（#29）、usage 管线无数据源（#30）、quota 族 501（#31，已登记）、插件族（#32，node install 500 vs S7:247 钉 501 未登记）、logs 族（#33）、OAuth 会话族分运行时（#34）。

### 3.6 状态与存储
Store 抽象 DIFFERENT-BY-DESIGN（#35）；node 默认 MemoryStore 重启全失，S6 §0:16"node keeps a file adapter"与实现相反（未登记虚报，见 §4-U1）。上游 file/git/object/postgres 四后端无对应。一致性模型分列（#38，已登记）。行为新增：DO/KV usage 队列重启存活（#37，未登记）。热载/监听缺席（#36）。cache 族缺席（#52，未登记）。

### 3.7 运行时与平台差异
node 五子项缺席（#39，GR-5 逐行登记）；capabilities 常量与审计现实矛盾（#40，未登记）；环境代理忽略（#41，NE-S7-04）；出站代理分列（#42）；vercel 流边界（#43）；client IP 三源（#44）。DEPLOYMENT §5.2 矩阵与源码逐格核对一致（proxy-url node 列"ingestion never landed"=config.ts 确无 proxy-url 读取；RESP 行"NO runtime ships the raw TCP listener"=grep 证实）。

### 3.8 上游运维面
插件 ABI/宿主/商店（#51/#32）、TUI（#46）、Home 集群（#45）、控制面板资源（#49）、pprof（#47）、mDNS/DNS-SD（#48）、文件日志+错误 dump（#33）、热载与文件监听（#36）、代理出站（#42/#41）、Redis-RESP 旁路（#50）、入站 WebSocket（#7）、Go SDK 嵌入式（#55）、C-ABI 插件（#51）、分发面（#56）。internal/cache 族归 #52。

### 3.9 配置面（config.example.yaml 逐键四类）

| 标签 | 键 | 证据 |
|---|---|---|
| 接受且消费 | host 仅注释级（bind 走 listenGateway 选项）；port、api-keys、remote-management.{allow-remote,secret-key,disable-control-panel}、disable-image-generation（四态）、ws-auth、request-retry、transient-error-cooldown-seconds、claude-code.disable-cloaking-model-list、codex.disable-codex-cloaking、8 个 provider 块（api-key/base-url/headers/name/models + 条目 name/alias/display-name/image/is-compat/force-mapping/thinking/fingerprint-profile） | runtimes/node/src/config.ts:236-262,206-232；DEPLOYMENT:180-210 |
| 接受-惰性（echo+round-trip，无消费方） | debug、commercial-mode、logging-to-file、logs-max-total-size-mb、error-logs-max-files、usage-statistics-enabled、redis-usage-queue-retention-seconds（仅 retention 计算）、proxy-url（node 不收；cf/vercel 收而 fail-closed）、force-model-prefix、passthrough-headers、request-log、max-retry-credentials、max-retry-interval、disable-cooling、save-cooldown-status、quota-exceeded.*、routing.*、nonstream-keepalive-interval、streaming.keepalive-seconds/bootstrap-retries、xai.inject-x-search、codex.* 大部（identity-confuse/stream-bootstrap-*/optimize-multi-agent-v2/orphan-delegation-compatibility/model-level-cooling/live-media-relay.*）、claude-header-defaults.*、codex-header-defaults.*、disable-claude-cloak-mode、payload.*、oauth-excluded-models/oauth-model-alias/oauth-request-scoped-errors（CRUD 有、运行时无消费）、antigravity.*、devin.*、credential-concurrency.*、credential-in-flight.*、auth-auto-refresh-workers | packages/management/src/config.ts:478-548；GR-6（SPEC.md:79）伞；commercial-mode/passthrough-headers/request-log 未点名（#53） |
| 平台 ABSENT（键收而忽略或无此面） | tls.*（node 无 TLS listener）、pprof.*、discovery.*、plugins.*（含 store-sources/store-auth；加载 ABSENT）、auth-dir（无文件底座）、remote-management.panel-github-repository（无下载器） | NE-S7-08；GR-5；runtimes/node/src/server.ts 仅 node:http |
| 无此 key 建模（raw-only，管理视图未建模） | gpt-image-2-base-model、video-result-auth-cache-ttl、antigravity-signature-cache-enabled、antigravity-signature-bypass-strict、claude-header-defaults.stabilize-device-profile | config.example.yaml:407-413；packages/management/src/config.ts 视图无对应；未单列登记 |
| EDGE-ONLY（本项目新增键） | vercel CPA_CONFIG_JSON / CPA_CONFIG_YAML / CPA_CONFIG_FROM_KV（serverless 配置注入） | DEPLOYMENT §3.2/§4.2（已登记）；runtimes/vercel/src/config.ts |

## 4. 未登记差异清单（实际行为 vs 自身文档）

| # | 条目 | 文档说法（file:line） | 实际行为（file:line） | 影响 |
|---|---|---|---|---|
| U1 | node 文件持久化虚报 | S6-state-storage.md:16"runtimes/node keeps a file adapter" | runtimes/node/src 全部源文件无 node:fs/writeFile/readFile；gateway.ts:496 默认 MemoryStore；DEPLOYMENT:166 自认"state does not survive restart" | node 重启全失 auth/config 状态 |
| U2 | capabilities 常量 vs GR-5 | capabilities.ts:32-41 node 四项 true | SPEC.md:78 GR-5 + DEPLOYMENT:474-485 明文 REGISTERED ABSENT；node 代码不消费这些标志（grep 仅 cf 消费） | 描述符自称"single source of truth"与审计现实矛盾 |
| U3 | usage 管线无数据源 | DEPLOYMENT:485/286"usage-queue HTTP keeps semantics"；S6 §0:19"enqueue() on request completion" | runtimes/{node,cloudflare} grep recordUsage 0 命中；api-key-usage 恒 0（usage.ts:293-305）；toggle 无消费（api.ts:797-802） | usage-queue/RESP usage 通道/api-key-usage 全部空转 |
| U4 | oauth-maps PATCH 语义 | S5-management-api.md:130-132（404 provider/channel not found 家族） | api.ts:1313-1390 PATCH 恒 200 ok；无 invalid provider 400 | 合同覆盖即红 |
| U5 | api-call $TOKEN$/auth_index | S5 §2.3（$TOKEN$ 替换语义） | api.ts:1866-1920 无替换、不读 auth_index | 管理调试工具凭据注入面缺失 |
| U6 | reset-quota 不生效 | S4-scheduling.md:168"immediately schedulable again" + S4-07 金档 | api.ts:1807-1816 仅回 200，无任何 cooldown 重置调用 | 用户 reset 后冷却照样阻塞 |
| U7 | 429 窗内语义 | S4-scheduling.md:126"至多升一次/窗"（与本地实现一致） | 上游 conductor_cooldown.go:2256-2271 窗内不升不延；本地 cooldown.ts:199-219 窗内升一级可延长 | spec 与上游代码互斥，待裁定 |
| U8 | codex plan_type | S3-auth-flows.md codex 档字段集无 plan_type（code flow） | token-exchange.ts:244 code flow 写 plan_type | 持久档越出钉定 schema |
| U9 | quota signals | S4 §2.8/§3.1 quota 信号族 | cooldown.ts:46-55 无 signals；auth-files cooldowns=[]（api.ts:101） | quota 观察面缺失 |
| U10 | latest-version 形状 | S5:80 EXTERNAL + S5:333 502 家族 | api.ts:608-611 恒 500 | 形状差未登记 |
| U11 | node plugin-store install 500 | S7:247 install MUST 501 F2 体"always (project-wide)"（S7:498） | node 无包装：facade api.ts:697-700 回 500 handler unavailable；cf/vercel 有包装 | node 与 S7 钉位不符 |
| U12 | request-error-logs node/cf 恒空 | OQ-S7-02（S7:617-622）称 cf dump 经 DO 持久 | cf grep error-dump 0 命中；api.ts:669-677 恒 {"files":[]} | 每请求错误 dump 全平台无产出（vercel 501 已登记） |
| U13 | usage 队列重启存活 | 上游 queue.go:24-37 纯内存 | DO/KV 持久（do-store.ts:8-30、kv-store.ts:8-30） | 低风险行为新增 |
| U14 | 4 对翻译方向缺席未点名 | GR-3 仅列 cla2cla/gem2gem/xai/meta/interactions/vertex | cla2codex/gem2codex/res2gem/res2cla 无模块（gateway.ts:178-247 无条目） | 登记缺口 |
| U15 | cache 族缺席 | S2d10 签名缓存键有 schema（S6:318） | 全仓无 LRU/replay/signature 缓存实现 | 配置键无实现 |
| U16 | commercial-mode/passthrough-headers/request-log 惰性 | GR-6 清单未点名此三键 | 均仅 echo（config.ts:492,508；api.ts:803-807）；上游三者皆有真实消费方 | GR-6 伞下未点名 |
| U17 | resp.ts 注释过期 | resp.ts:3-5"the node runtime binds this to its multiplexed TCP listener" | node 无任何 listener 绑定（DEPLOYMENT:485 已登记缺席） | 注释与登记矛盾（小） |
| U18 | executors 包残留占位注释 | R-EXECS：执行面由方向模块满足（已交付） | packages/executors/src/index.ts:1"skeleton placeholder, replaced by the assigned implementer" | 交付代码残留占位措辞（小） |

**交叉检查 (a)——"自称缺失但实际可用"：0 条命中。** 检查方法：对每个登记缺席项反向找实现——GR-1（config.ts FAMILY_ORDER 仅 8 个 api-key 家族 + registry.ts 仅由 config 派生，OAuth 凭据无派发路径）；GR-2（packages/translators/src、packages/executors/src grep antigravity 0 命中）；GR-3（DIRECTIONS 表 merged:false 条目 + directionNotMerged 唯一出口）；NE-S7-02（无 FFI/dlopen 等价，plugin-store 全 500/501）；GR-5 各子项（runtimes/node grep node:fs/tls/proxy/watcher 0 命中；recordUsage 0 命中）；F8（三运行时 grep RESP listener 0 命中）。未发现任何"登记为缺席但源码里实际存在实现"的条目。

**交叉检查 (b)——"自称已交付但实际不成立"：命中 U1-U12、U16-U18**（上表双证）。其中 U1/U2/U3 为文档/常量级虚报，U4-U7/U10-U12 为 spec 文本与实现不符，U16-U18 为登记或措辞缺口。

## 5. 未验证清单

| # | 条目 | 缺什么 | 需要什么 |
|---|---|---|---|
| V1 | Claude/Codex/Antigravity token exchange 200 真实结构 | vendor 真实响应 | 真实 OAuth 凭据完成授权流 |
  → 阻塞原因/需要什么：需要 Claude、Codex、Antigravity 三家的真实 OAuth 授权码走完一次完整授权（authorize→回调→token exchange），录下 token endpoint 的 200 成功体原始 JSON；测试账号与 mock 不算数。
| V2 | refresh 200 body + 429 Retry-After(-Ms) 头戴 | vendor 刷新实录（含 429） | 同上 |
  → 阻塞原因/需要什么：需要各家 refresh token endpoint 的真实 200 body 字段集，以及一次真实 429 响应的头（Retry-After 与 Retry-After-Ms 同时出现时谁优先、头上限）；通常要在配额打满或短期高频刷新下才能录到 429。
| V3 | Kimi/xAI/Meta device grant 200 payload | device 完成实录 | 真实 device flow |
  → 阻塞原因/需要什么：需要 Kimi、xAI、Meta、Codex 四家 device flow 各从零走完一次完整流程（device code 申请→用户授权→poll 直至 200），录下最终 grant 成功 payload；本仓库 device-flows.ts 的 envelope 是按文档/类型推的，未经现场确认。
| V4 | Meta muse-code/key mint 200 键值 | mint 实录 | Meta 真实 DCA token |
  → 阻塞原因/需要什么：需要一枚真实 Meta DCA token 实际调用 muse-code / key mint 接口并录下 200 响应体键值；该端点不属公开 OAuth 文档，无真实凭据无法取证。
| V5 | Devin /auth/cli/token 与 /v3/self 响应 | vendor 实录 | Devin 真实会话 |
  → 阻塞原因/需要什么：需要一个真实 Devin 账户会话，录到 POST /auth/cli/token（CLI 换 token）与 GET /v3/self（当前身份）的原始响应；Devin 文档不开源，必须真实账号。
| V6 | xAI OIDC discovery 返回体 | .well-known 实录 | 外网可达 |
  → 阻塞原因/需要什么：需要在外网环境真实 GET 一次 xAI 的 OIDC .well-known/openid-configuration 并留存响应体（签发方/端点集/jwks_uri）；离线 mock 无法核对键名与 issuer 字符串。
| V7 | vendor 错误字面量（expired_token/access_denied/refresh_token_reused） | 错误实录 | 刻意触发 vendor 错误 |
  → 阻塞原因/需要什么：需要对各家分别刻意触发一次真实错误并重放：过期 refresh_token（expired_token）、用户拒绝（access_denied）、refresh token 复用（refresh_token_reused），录下 exact error 字段串；各家错误字面量不一致，不能相互推算。
| V8 | refresh-on-401 全链（401→刷新→重放） | 全链实录 | 有效凭据 + 上游 401 场景 |
  → 阻塞原因/需要什么：需要一次真实链路上游主动返回 401（如凭据被吊销或 token 提前失效），录下本代理 refresh→重放→二次响应的完整时序；人为 mock 401 无法证明走的是 vendor 真实拒绝路径。
| V9 | Home/面板/TUI 真实行为（资产下载内容、home-jwt 握手、TUI 交互） | 上游部署面实录 | 上游 home/panel/TUI 环境 |
  → 阻塞原因/需要什么：需要一套真上游 CLIProxyAPI 部署（本机 go1.24.4 不可构建，需 go1.26 环境或官方镜像），现场观察 home-jwt 成员握手、面板的 GitHub 资产实际下载内容、TUI 各 tab 的真实交互；直播行为不能从源码反推。
| V10 | 上游构建/运行对照（go 1.26、docker 镜像实跑） | 本机 go 1.24.4 不足 | go 1.26 或 oracle 镜像环境 |
  → 阻塞原因/需要什么：需要 go1.26 构建环境或官方预构建镜像，把上游真实跑起来并回放一遍关键路径（启动/登录/转发/管理面）；只读源码只能确认"注册了"，无法确认运行时行为与启动副作用。
| V11 | realtime client_secrets/sessions 成功体、hangup 成功转发体 | 成功路径金档 | 真实 codex live 会话 |
  → 阻塞原因/需要什么：需要一个真实 Codex 会话在此分支上发起一次 realtime client_secrets 与 sessions 请求并录下成功体字段，以及一次真实 hangup（WS 中断）时上游最终转发体的形状；realtime 中继尚未实现（报告 #6/#7），只能借真上游或正式 codex live 端点现场录。

## 6. 前 10 条按影响排序

1. **#14 OAuth 凭据不服务（GR-1）**——上游的核心价值（CLI 订阅代理）在 v1 整体缺席；已登记，v1.1 头号目标。
2. **#30 usage 统计管线未接服务路径（未登记）**——usage-queue/api-key-usage/RESP usage 通道全部无数据源，且 DEPLOYMENT"keeps semantics"说法与实际相反。
3. **#21 调度引擎未接服务路径（GR-4）**——多账号轮换在 v1 仅 config-order first-fit；策略/权重/亲和 echo-only。
4. **#9 四对翻译方向缺席（未登记）**——cla2codex/gem2codex/res2gem/res2cla 在上游是实体翻译器，本地 503 缝且 GR-3 未点名。
5. **#10 antigravity 执行面缺席（GR-2）**——18 goldens 完整录而未实现。
6. **#35/U1 node 无持久化 + S6 file adapter 虚报**——重启全失 auth/config 状态，文档与实现相反。
7. **#23 reset-quota 不生效（未登记）**——S4-07 金档承诺的立即可调度未实现，管理面功能性死端。
8. **#6/#12 转发面缝族（GR-1/2/3）**——images/videos/live/realtime relay/原生透传多个客户端功能族 v1 全落 503。
9. **#39 node 五子项缺席（GR-5）**——proxy 拨号/TLS/热载/后台刷新/device 轮询/loopback，长时自托管部署的直接短板。
10. **#28/#29/#27 管理面语义缺口（未登记族）**——oauth-maps PATCH 恒 200、api-call 无 $TOKEN$、latest-version 恒 500：合同测试一旦覆盖即红。

---
统计：总表 57 行。主分类计数：EQUIVALENT 8、DEGRADED 18、ABSENT 16、DIFFERENT-BY-DESIGN 5、EDGE-ONLY 3、混合/分列 7。未登记差异 18 条（U1-U18）。未验证 11 条。
命令记录：上游 `git rev-parse HEAD` / `git describe` / `git status`（锚点核验）；`go version`（1.24.4，不构建上游）；双侧 grep/sed 取证约 40 次（路由注册、config 键、translator 注册、管理 handler、运行时消费点）；未跑 pnpm 测试（纯源码比较，按任务规则）。
