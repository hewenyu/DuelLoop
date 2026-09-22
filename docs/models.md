# 模型接入与真实实验

DuelLoop 的快循环通过 `DecisionModel` 接口使用 Jev Score，慢循环通过 `ResearchProvider` 使用 pi。凭据来自应用指定的环境变量；SDK 不写入作者账号或密钥，不读取本机 pi 的持久凭据文件，不允许研究模型访问通用文件或命令工具。

当前锁定依赖是 `@typesafe-ai/sdk@0.6.0`、`@earendil-works/pi-coding-agent@0.87.0` 和 `@earendil-works/pi-ai@0.87.0`。安装后的实际模型清单取决于该 pi 版本内置目录；不在目录中的模型会明确报错，不自动换成其他模型。框架不会把传输成功解释为该模型适合你的领域。

当前已通过官方端点实测 `jev-1.13.0` 的 Score / Choice 传输，以及 pi 调用 DeepSeek `deepseek-flash` 的受控工具会话。DeepSeek 使用 `provider: 'deepseek'`，由当前 pi 目录选择官方端点和协议；该目录中的模型 ID 不是 `deepseek-chat` 或 `deepseek-reasoner`。这些接入结果不代表自主闭环验收已通过，也不证明策略收益。

## 凭据与模型配置

推荐通过环境变量引用配置，不把密钥写入应用配置、策略、命令行参数或版本控制。

仓库的 `.env.example` 提供上述模型配置及空凭据字段。首次使用时复制为本地 `.env`，通过自己的安全渠道填写 `TYPESAFE_API_KEY` 和 `DEEPSEEK_API_KEY`；已有 `.env` 时保留原文件并逐项核对。`.env` 不应提交版本控制。SDK 本身不自动加载 `.env`，直接执行 Node.js 脚本时使用 `--env-file=.env`；`npm run test:live` 已配置 `--env-file-if-exists=.env`。示例文件不启用付费调用，仍须在运行命令中显式设置授权开关。

`DUELLOOP_LIVE` 仅控制本仓库的付费实验脚本与 live 测试，不是 SDK 或 CLI 的全局安全开关。应用配置真实 `JevDecisionModel` / `PiResearchProvider` 或 CLI 真实模型后，执行相应操作就会调用远端，即使未设置该变量。由 fixture 应用切换真实模型时，首次接入可使用新的应用数据库；已有应用应走正常的行为依赖升级与重新评价流程，不能静默沿用绑定旧模型的发布。

```js
import { JevDecisionModel, PiResearchProvider } from 'duelloop';

const decisionModel = new JevDecisionModel({
  model: process.env.DUELLOOP_JEV_MODEL,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  timeoutMs: 5000,
});

const researchProvider = new PiResearchProvider({
  provider: process.env.DUELLOOP_PI_PROVIDER,
  model: process.env.DUELLOOP_PI_MODEL,
  apiKeyEnv: process.env.DUELLOOP_PI_KEY_ENV ?? 'DEEPSEEK_API_KEY',
  maxTurns: 16,
});
```

`JevDecisionModel` 的 `baseURL`、`PiResearchProvider` 的 `baseURL` / `api` 可以显式覆盖已知提供方的接入地址及协议。覆盖端点不会放宽模型、回答及工具权限校验。不要向不可信地址发送密钥或领域状态。

Jev 策略运行时只消费 Score：每个问题需要 2—10 个具体等级，分数可为期望值而非整数，归一化使用 `score / (levels - 1)`。低置信度、缺失回答和超时按策略及领域基线处理。`0.55` 是示例阈值，不是领域通用默认最优值。Jev `choice()` 仅用于 M0 对照；Noul 不在第一版策略执行语言中。

Score / Choice 的概率字段先校验标签和有限的 `[0,1]` 值。概率和与 1 的偏差在原有 `0.01` 容差内（另计浮点运算误差）时，适配器按实际总和归一化；超出容差则拒绝。真实开发回答中出现过概率和为 `0.99` 的分布，离线回归覆盖了该情形。归一化不修改模型返回的 `score`、`confidence`，也不放宽策略门槛；决策记录保留的是归一化概率。

请求中的模型 ID 必须与返回的实际 ID 一致，否则框架拒绝沿用原行为依赖。请选用服务实际返回的可固定版本 ID；使用随服务更新的别名可能触发不兼容诊断。升级模型、问题语义、特征、基线、参考续打策略或执行时间预算后，应重新评价。

pi 会话只启用当前研究任务的受控工具：经验、基线与规则、开发历史、开发实验、行为夹具登记以及候选提交。单模型复用一个会话；团队模式每个角色独立会话，即使三个角色配置了同一模型。SDK 明确关闭默认扩展、AGENTS、skills、提示模板及内建 bash/read/edit/write 发现；离线适配器测试会检验实际 SDK 的隔离行为。

pi 优先请求一个完整 JSON 值，也接受只包含该值的单一 JSON 代码围栏，不从混杂散文中猜测 JSON 子串。`researcher` / `adversary` 的非空完整文本若不是 JSON，首次即保留为 `{analysis: 原文, format: 'plain_text'}`，无需格式修复；其中提到的 `no_change`、`revise` 或候选字段只是分析文字，不自动转成控制指令或策略提交。有效 JSON 仍按原样返回。空文本和截断回答不会作为有效分析接受。

`integrator` 及其他角色仍严格要求 JSON。完整响应格式错误时，最多追加一次同会话格式修复，并暂时关闭全部工具，要求仅重排已有分析。修复限制仅适用于紧接的一次回复；下一研究阶段明确恢复按当前指令分析与使用当前工具。该请求共享原 `maxTurns`、token 和取消限制，不增加预算，也不替代候选提交校验；成功或再次失败均保留累计用量。它与研究编排器的候选修复次数 `maxRepairAttempts` 分别计数。截断、传输失败或已无已知剩余预算时，不尝试格式修复。所有候选仍必须通过 `submit_candidate` 的类型化契约、独立验证和发布检查，角色分析格式不改变这些门槛。

## 运行边界与预算

应用创建 `ResearchOrchestrator` 时注入领域、模型、评价器及 `runtime.dependencies`，创建任务时绑定最终协议和独立开发协议。不要自行复制一份忽略运行时间预算的依赖列表。开发集与保留集使用不同 ID 和不重叠种子。

| 限制 | 作用 |
| --- | --- |
| `budget.maxWallTimeSeconds` | 研究创建后的总墙钟上限 |
| `budget.maxTokensTotal` | 所有研究会话及开发/最终评价模型调用的总 token 上限 |
| `budget.maxModelCalls` | 研究 provider 调用总数，覆盖角色及修复 |
| `budget.maxDecisionModelCalls` | 开发/最终实验的决策模型调用总数 |
| `budget.maxRepairAttempts` | 每个整合阶段没有有效提交时的有界修复 |
| `maxRounds` | 研究、质疑、整合的最大轮数；整合者可返回 `revise` 请求下一轮 |
| `PiResearchProvider.maxTurns` | 单次 provider 调用内的模型/工具轮次上限 |
| `protocol.maxDevelopmentEvalRuns` | 开发实验次数 |
| `protocol.maxFinalEvaluationsPerRun` | V1 固定为 1 |
| `protocol.maxHoldoutUses` | 同一持久存储中、跨研究任务的保留集使用总数 |

用量是服务返回后的实际值；框架通过每次调用前的预算、单次生成上限、超时和返回后的累计计数约束后续步骤，不能承诺远端计费零超额。无法确认 token 用量时，研究停止并标记 `budget_exhausted`；取消中未确认的远端费用保留为未知，不能记成零。Jev 当前 token 计数可用，但 SDK 未提供美元价格时报告标记未知费用。pi 返回的 `costUsd` 是锁定 SDK 按价格表计算的估算，不能代替提供方账户账单。

pi 每次收到模型响应就通过 `onUsage` 通知累计用量；框架将尚未结算的研究用量与开发评价用量合并检查。`getRemainingTokens` 提供实时剩余预算，pi 再扣除本次调用自身尚未入账的累计用量，因此开发工具耗费额度后，下一轮模型请求和格式修复都会看到变化。自定义 `ResearchProvider` 若在一次 `run()` 内执行多次远端请求，也应使用这两个可选回调；只在最终返回用量的 provider 仍会被终局预算检查，但无法保证调用内部的逐次限制。

取消先提交会阻止后续步骤；晚到结果只能追加审计。进程崩溃后，无法安全确认的研究/实验不会重新发送付费调用：`recover()` 结束为 `error`，已用配额保留。`cancel_requested` 恢复为 `cancelled`。这是当前的保守恢复行为，不是跨进程重建远端会话。

## 无密钥验证

先在项目根目录执行 `npm ci` 和 `npm run build`。普通 `npm test` 不发出付费请求。以下命令仅测框架和明确标记的 fixture：

```sh
node scripts/m0.mjs --fixture --hands 20 --output artifacts/m0-fixture.json
node scripts/benchmark.mjs --fixture --steps 1000 --output artifacts/runtime-fixture.json
DUELLOOP_LIVE=0 npm run test:live
```

最后一条命令明确关闭付费请求，即使本地 `.env` 存在凭据也显示跳过，不能作为真实模型验收证据。fixture 报告的 `modelKind` 是 `fixture`；它们不证明 Jev 的延迟、牌力或 pi 的研究价值。

M0 的三个路径为领域基线、Jev Choice 和 Jev 多维 Score。每个路径从同样的种子、对手设置和空知识快照创建独立环境；动作不同后环境可自然分歧。默认冻结跨轨迹知识。脚本记录收益、调用量、p50/p95/p99、吞吐、超时、降级及未知用量；原始分块数据保留用于复核。测得的收益仅适用于指定对手和条件，不属于独立保留集证明。

benchmark 通过公共 SDK 执行完整 `step()`，包含磁盘 SQLite WAL 的决策、意图和回执写入。它测顺序处理吞吐；默认用一个流，报告中的 warmup 调用也计入费用。fixture benchmark 的耗时只是本地运行时和存储开销，不能代替真实端到端延迟。

## 真实 M0 与端到端耗时

在本机安全配置好 `TYPESAFE_API_KEY` 后，设置明确的 Jev 模型 ID。脚本必须收到 `DUELLOOP_LIVE=1` 才发出付费请求：

```sh
# .env 中配置 DUELLOOP_JEV_MODEL=jev-1.13.0 及你自己的凭据。
DUELLOOP_LIVE=1 DUELLOOP_LIVE_CLOSED_LOOP=0 npm run test:live
DUELLOOP_LIVE=1 node --env-file=.env scripts/m0.mjs --hands 20 --seeds 11,29,47 --opponents calling,tight,random --max-calls 1000 --timeout-ms 5000 --output artifacts/m0-real.json
DUELLOOP_LIVE=1 node --env-file=.env scripts/benchmark.mjs --steps 100 --max-calls 150 --timeout-ms 5000 --output artifacts/runtime-real.json
```

凭据使用其他环境变量名时设置 `DUELLOOP_JEV_KEY_ENV`。可通过 `DUELLOOP_JEV_BASE_URL` 指向明确配置的接入端点。真实实验未运行、预算耗尽或模型版本不匹配时，脚本不会生成“真实通过”的结论；`incomplete` 和 `not_executed` 返回非零退出码。

## 真实 pi 自主闭环验收

2026-09-22 已完成一次受控验收，详见[受控闭环验证摘要](validation.md)。该次使用 `jev-1.13.0`、`deepseek-v4-pro`、`passive` 初始策略、初始阈值 `0.10`、每块 8 手、研究预算 2,000,000 tokens 及每次 provider 最多 32 轮。模型自主改变权重、分支与阈值，独立验证通过并用于后续 20 次步骤。下列默认配置仅是有界实验起点，不保证每轮产生更新，也不保证较小预算能够完成同样任务。

`test/live/models.test.mjs` 只是 Score、Choice 和受控 pi 工具的传输冒烟测试。完整闭环由 `test/live/closed-loop.test.mjs` 单独执行；它会产生更多付费模型调用，因此另需 `DUELLOOP_LIVE_CLOSED_LOOP=1`。

```sh
# .env 示例配置：DUELLOOP_PI_PROVIDER=deepseek，
# DUELLOOP_PI_MODEL=deepseek-flash，DUELLOOP_PI_KEY_ENV=DEEPSEEK_API_KEY。
# 凭据通过自己的安全渠道事先提供；本命令会产生付费请求。
DUELLOOP_LIVE=1 DUELLOOP_LIVE_CLOSED_LOOP=1 node --env-file=.env --test test/live/closed-loop.test.mjs
```

该实验创建一个有明确偏好缺陷的初始策略，让真实 Jev 产生执行经验，再让真实 pi 自行读取经验、研究、登记行为夹具、提交候选。框架执行独立真实 Jev 评价，成功后通过 SDK 激活并记录后续动作。实验不提供手写候选，也不把 fixture 候选当成 pi 的研究成果。

实验的默认保护为：最多 1,200 次真实决策调用，研究累计最多 600,000 tokens，最多 8 次研究 provider 调用、2 次开发实验及 1 次最终评估。单次决策默认 10 秒，研究默认 900 秒。整个测试的默认时限按 `ceil((experienceSteps + 2 × postSteps) × decisionMs / 1000) + researchSeconds + 60` 计算；默认 30 个经验步骤、20 个激活后步骤时为 1,660 秒，包含可能追加的旧问题请求和 60 秒清理余量。显式设置测试时限会覆盖此公式。这些是调用上限而非价格估算，运行前按账户预算调整以下环境变量：

| 环境变量 | 调整内容 |
| --- | --- |
| `DUELLOOP_LIVE_MAX_DECISION_CALLS` | 包含经验收集、研究评价及激活后观察的总决策调用上限 |
| `DUELLOOP_LIVE_MAX_TOKENS` | 研究及其评价的 token 上限，不含研究前经验收集 |
| `DUELLOOP_LIVE_PI_MAX_TURNS` | 单次 pi provider 调用的轮次上限 |
| `DUELLOOP_LIVE_RESEARCH_SECONDS` / `DUELLOOP_LIVE_TIMEOUT_SECONDS` | 研究和整个测试时限 |
| `DUELLOOP_LIVE_DECISION_MS` | 单次实时及实验决策预算 |
| `DUELLOOP_LIVE_MIN_CONFIDENCE` | 仅设置受控实验初始策略的置信度阈值，范围 `[0,1]`，默认 `0.55`；不是 SDK 全局默认值，也不放宽最终评价协议 |
| `DUELLOOP_LIVE_EXPERIENCE_STEPS` / `DUELLOOP_LIVE_POST_STEPS` | 初始经验及激活后观察步数 |
| `DUELLOOP_LIVE_HANDS_PER_SEED` | 每个实验块的手牌数 |
| `DUELLOOP_LIVE_INITIAL_POLICY` | 受控初始缺陷：默认 `inverted_weights` 为逆向权重；`passive` 为全零动作效用，使用独立作用域。两种条件共用同一数据库中的最终保留集额度，不会重置已用额度 |
| `DUELLOOP_LIVE_OUTPUT_DIR` | 持久实验目录；默认 `artifacts/live-closed-loop` |

最终实验的种子与样本不进入研究提示或开发工具。目录中的 `evidence.sqlite` 持久登记保留集访问，分次结果存入时间戳子目录。不要删除数据库或更换目录来重试同一保留集；合法的新独立实验应事先制定新的协议与保留条件。已经成功激活的受控应用不自动重置初始策略。

初始缺陷的选择也是实验设计的一部分。逆向权重可能在部分对手上碰巧形成有效打法，研究没有验证出稳定改进时应保留该结论。全零效用条件用于检验更明确的决策缺陷；它依然只提供初始策略和经验，研究模型必须自主提出候选。更换条件不能绕过最终保留集的使用限制，也不能替代正常基线上的改进实验。

`DUELLOOP_LIVE_MIN_CONFIDENCE` 应在本轮实验开始前确定，并记录在结果和初始策略中。它不修改正常示例策略，也不改变最终协议的最大降级率等要求；已有持久实验若初始策略摘要不同会被拒绝，不能借调整该值悄悄重置同一保留实验。

`no_change`、验证拒绝、证据不足和预算停止会如实写入产物并将 R2 标记为未证明；测试显示跳过，不能记为 R2 通过。仅当真实研究提出、独立验证、激活和后续动作变化都留下证据，才记录受控模拟环境中的 R2 能力。

激活后的行为检查比较同一观察下的完整动作概率分布。问题与输入摘要相同时，新旧组合器复用同一回答；问题改变时，候选使用实际决策中的真实回答，旧策略针对同一可见观察另行请求真实 Jev 回答，再分别计算动作分布。额外请求共享总决策调用预算，回答摘要和比较方式写入证据。不会用旧问题的回答证明新问题有效，也不会把一次随机动作不同当成分布改变。未完成采样或未观察到可比较的分布变化时，明确标记部分完成。这类对照证明观察到的行为变化，不证明重复稳定性或收益；收益依据仍是独立配对实验。

该能力验收不能替代正常基线上的收益研究。Kuhn 中通过也不证明接入你的实际 bot、交易环境或其他对手后能够改善表现。部署前应使用自己领域的完整决策系统、时间预算和独立评价协议重做实验。

## 快循环与实验 worker 的并发影响

`concurrency-benchmark.mjs` 比较两个有界阶段：一个 fast worker 独立运行，以及 fast worker 与 slow evaluation worker 同时运行。两个 worker 使用独立 SQLite 连接，共用同一磁盘 WAL 数据库；实验逐次记录模型用量和评价产物，形成实际的 CPU、磁盘及 SQLite 写入竞争。两个阶段分别新建数据库，快循环使用相同种子、对手、策略、知识快照、预热步数和决策预算。

```sh
node scripts/concurrency-benchmark.mjs --fixture --repetitions 3 --steps 1000 --warmup 10 --slow-runs 100 --slow-hands 8 --wall-seconds 120 --output artifacts/concurrency-fixture.json
```

报告列出机器、Node.js、模型模式、并发 worker 数量、实验规模，以及两阶段快循环的 p50/p95/p99、超时率、降级率、吞吐和模型用量。`concurrentFraction` 表示实际与实验重叠的快循环样本比例，`latencyWhileEvaluationActiveMs` 单列这些样本；实验先达到规模上限时，不把剩余独立快循环冒充并发样本。慢 worker 在快循环结束后完成当前实验即停止，也受 `--slow-runs`、`--max-slow-calls` 和 `--wall-seconds` 约束。

默认 `--repetitions 3`，也允许设为 1。每次重复的两个阶段都新建独立数据库；奇数次先测独立运行，偶数次先测并发运行，以减少固定测量顺序的影响。报告的 `repetitions` 保留每次比较，`descriptiveSummary` 给出完成重复中的 p95 时延比、吞吐比等指标的最小值、最大值和均值。这些范围表达观测到的重复波动，不是统计置信区间；单次结果没有重复波动的估计。Schema 1.1 顶层的 `standalone`、`concurrent` 和 `comparison` 仍指第一次重复，汇总必须读取 `descriptiveSummary`。

默认每阶段最多 1,200 次快循环调用（包含预热），慢 worker 每个并发阶段最多 10,000 次调用。所有预算按阶段计算：重复 R 次的快循环总调用上限为 `2 × R × max-fast-calls`，慢模型为 `R × max-slow-calls`，慢实验为 `R × slow-runs`，阶段墙钟预算之和为 `2 × R × wall-seconds`（不含初始化、报告和终止开销）。默认 3 次最多 7,200 次快调用与 30,000 次慢调用；这是上限，慢 worker 通常在快循环结束后提前停止。使用 `--steps` 增加规模时相应调整 `--max-fast-calls`，避免配置不足。`--timeout-ms` 同时绑定运行器及评价器的决策预算。脚本只执行开发评价工作负载，不运行 pi 研究对话，不登记或激活候选发布。

真实端点实验仍需明确配置 Jev 模型、凭据及 `DUELLOOP_LIVE=1`，并去掉 `--fixture`。fixture 结果只衡量这台机器上的本地计算、SQLite 竞争及 SDK 开销，不表示真实网络模型性能。短测及其描述性范围不是容量承诺，需要按目标部署环境、规模和重复次数自行制定性能验收标准。

## 正常基线的单模型与团队研究对照

真实三阶段与会话隔离已验证，正常基线的两种模式均为 `no_change`；公开结论与比较限制见[验证摘要](validation.md)，原始用量及失败记录仅保存在本地。

`scripts/team-live.mjs` 使用公共 SDK 和普通 `createKuhnStrategy()` 基线（示例置信度阈值 `0.55`），与故意设置缺陷的闭环能力验收分开。`single` 让同一个模型在一个会话内完成研究、对抗检查和整合；`team` 让同一个模型在三个隔离会话中承担这三个角色。运行前配置前文的 Jev、pi 模型与凭据；以下两次执行会产生付费请求：

```sh
DUELLOOP_LIVE=1 DUELLOOP_TEAM_LIVE=1 DUELLOOP_LIVE_RESEARCH_MODE=single node --env-file=.env scripts/team-live.mjs
DUELLOOP_LIVE=1 DUELLOOP_TEAM_LIVE=1 DUELLOOP_LIVE_RESEARCH_MODE=team node --env-file=.env scripts/team-live.mjs
```

不需要密钥的接口检查强制使用 fixture，不代表真实模型验收：

```sh
DUELLOOP_LIVE_RESEARCH_MODE=single node scripts/team-live.mjs --check
DUELLOOP_LIVE_RESEARCH_MODE=team node scripts/team-live.mjs --check
```

两种模式预先声明相同基线、经验条件、开发协议和预算，分别绑定独立的最终保留集 ID 与种子。每种模式最多一次开发评价和一次最终评价；默认目录 `artifacts/team-live` 内的 `single-evidence.sqlite`、`team-evidence.sqlite` 持久记录各自的保留集使用。不要删除数据库或更换目录重试同一保留集。最终协议在研究任务创建时绑定，最终样本与种子不提供给研究模型。

每次实验最多 6 次研究调用、每次调用 16 turns、研究及其评价累计 1,000,000 tokens（不含研究前经验）、包含经验的总决策调用 200 次；这些是上限而非费用估算。计划规模为 12 步经验、最多 32 次开发决策调用和 96 次最终决策调用，共最多 140 次。可通过 `DUELLOOP_TEAM_MAX_TOKENS` 将预算显式设为最多 2,000,000 tokens，通过 `DUELLOOP_TEAM_MAX_TURNS` 显式设为最多 32 turns；默认值仍为 1,000,000 / 16。单模型与团队对照应使用相同设置，选择模式本身不会增加额度。其他 `DUELLOOP_TEAM_*` 变量可降低调用上限。

结果保存到 `${mode}/${timestamp}/result.json`，包括角色会话、验证结论、耗时、调用量、token 和已知费用，未知费用会单独标记。实验固定为 `candidate_only`，不会激活候选。`no_change`、候选被拒绝或证据不足都可能是正确结果。两种模式各运行一次且使用独立保留集，只支持描述性比较本次结果及成本；不能据此宣称团队研究优于单模型，也不保证产生策略改进。
