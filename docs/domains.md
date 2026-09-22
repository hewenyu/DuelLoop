# 接入自己的对抗环境

领域接入由应用实现 `DomainDefinition`，不需要修改 DuelLoop 核心。`demo/market-domain.mjs` 给出完整的应用自有持续竞价环境，所有 SDK 引用只经过根入口；它没有继承 Kuhn，也没有要求核心认识市场规则。

## 领域契约

| 部分 | 实现要求 |
| --- | --- |
| 身份和版本 | `id`、`rulesVersion`、`featureContract`、`featureBuilderVersion`、`knowledgeUpdaterVersion`、`baselineVersion`、`continuationVersion` |
| `features` | 声明特征类型和必填性；字段可以使用扁平的点路径名称 |
| `context` | 提供具体规则、可见性、行动含义、计量单位、收益公式及有界的参考续打说明 |
| `observe(streamId)` | 返回应用、策略作用域、流、行动者、轨迹、修订、时间戳和行动者可见特征 |
| `candidates(observation)` | 返回当前合法有限动作集合，每个动作包含 ID、种类、参数及同一状态修订 |
| `fallback(observation, reason)` | 给出确定性领域基线动作；无法合法行动时返回 `null` |
| `execute(command)` | 可选；根据状态修订、截止时间、合法性和幂等键执行，返回有明确状态的回执 |
| `executionStatus(key)` | 可选；查询之前动作的真实结果，未知结果必须保持 `unknown` |
| `feedback()` | 可选；读取待交付反馈，支持按能力声明进行延迟结算和修订 |
| `canActivate(scopeId)` | 同步作用域检查点需要；判断当前是否允许改变默认发布 |

应用、策略作用域、流、行动者、轨迹共同限定记录归属。领域必须拒绝跨应用或跨行动者观察，隐藏牌、对手私有报价和模拟器未来随机结果不进入模型状态。SDK 会检查公开输入，但不能自动知道你的业务字段是否泄露了秘密。

动作参数由领域完整生成，不能让模型自行添加金额、资源数或非法动作。状态过期时拒绝旧命令；相同幂等键和同一命令应得到同一结果，相同键对应不同命令必须拒绝。领域应在自己的系统中持久化幂等核对，而不是依赖模型重试。

`accepted` 表示系统接受但未完成，`completed` 表示已确认完成，`rejected` 表示明确未执行，`unknown` 表示当前不能判断。网络超时不能直接等价为动作失败；框架会保留未核对执行，在后续动作前要求恢复核对。

## 激活和反馈

`activationBoundary: 'trajectory'` 在新轨迹绑定当时的默认发布；已有轨迹继续使用之前绑定的版本。`'scope'` 要求领域实现同步检查点，例如所有相关流的在途动作已经确认。检查点由业务定义，不强行等价于“一局游戏”。

`capabilities` 声明实际实现的执行、幂等、查询、延迟反馈、修订反馈和独立评价能力。没有独立评价器时仍可接入决策、积累经验和保存研究材料，但不能把影子输出当成已验证收益并自动授予发布资格。

终局收益按轨迹或领域评价窗口结算一次，不能复制成每个动作都赚到了完整终局收益。延迟反馈可以先提交 `settled: false`，后续以同一 `feedbackId`、更高 `revision` 提交结算值。保存事件发生时间和接收时间，不用修订后的结果悄悄改写旧快照。

## 独立评价器

`EvaluationAdapter.episode()` 接收策略、决策模型、随机种子、对手 ID、轨迹数量、初始知识、知识更新模式和取消信号，返回实际完成的平均收益、决策数、降级数、延迟、模型调用数和费用。每次调用必须创建隔离的环境、知识状态及可适应对手状态。候选和基线的同一配对种子只能共享初始条件，不能共享会被修改的实例。

- `frozen`：双方从相同快照读取知识，实验期间不更新对决策可见的统计。
- `online_update`：双方从同一快照开始，分别通过各自产生的经历更新统计。

评价器必须声明 `decisionPolicy: { maxDecisionMs, executionReserveMs, randomSeed? }`，描述实际使用的决策截止时间、执行预留和可选采样种子。`evaluateCandidate()` 在执行任何 episode 前核对该声明与发布的运行时摘要；缺失或不匹配会返回 `VERSION_INCOMPATIBLE`。自定义评价器仍需忠实实现自己声明的策略。

评价器还必须声明 `domainDependencies: Omit<BehaviorDependencies, 'model' | 'runtime'>`，包含实际模拟的 `rules`、`featureBuilder`、`knowledgeUpdater`、`fallbackBaseline`、`continuationPolicy` 和 `contextDigest`。框架逐组摘要核对它们与应用发布的依赖；仅传入 `app.dependencies` 不会把默认模拟器变成你的自定义领域。内置评价器从实际领域实现生成并冻结这些依赖，更改应用的基线版本、规则上下文或特征实现后，需要提供执行相同版本的评价器。

真实实验应调用传入的 `DecisionModel` 并执行整条模拟轨迹。固定回答测试只验证解释器，不证明模型理解新问题或收益提高。评价器应遵守实际运行的模型版本、问题生成、降级逻辑和时间预算；修改这些行为后需要重新验证。参考 `KuhnEvaluationAdapter`、`AuctionEvaluationAdapter` 的默认决策预算为 5000ms，执行预留 25ms，可通过构造参数与应用保持一致；应用设置 `randomSeed` 时，评价器也必须传入同一值。内置评价器先编译校验完整策略，再运行模型；结构或领域版本不匹配会终止实验，不计为基线降级。未固定应用采样种子时，实验用协议种子控制随机抽样以便重复比较；固定种子时，实验复用运行时按轨迹与修订派生随机数的公式。

当前评价报告把一个随机种子下、按协议对手集合汇总的配对结果作为独立样本。`minSamples` 不能用同一局的动作数量充数；独立评价数据与研究可见开发数据分开保存。

## 合规测试

```js
import { runDomainConformance } from 'duelloop';
import { MyMarketDomain } from './market-domain.mjs';
const report = await runDomainConformance(() => new MyMarketDomain(), {
  streamId: 'market',
  forbiddenFeaturePaths: ['opponent.bid', 'competitorBid'],
});
if (!report.passed) throw new Error(JSON.stringify(report.checks));
```

factory 必须创建独立、可重复的沙箱环境。合规套件会真实调用 `execute()`，不要传生产执行适配器。每项结果都有 `passed`、`failed` 或 `skipped`；可选能力未声明、隐藏状态路径未给出或边界场景夹具缺失时明确标记跳过，不将其记为能力验证成功。

`noActionFixture`、`forcedActionFixture` 可分别提供包含 0 个和 1 个候选动作的 `{ domain, observation }`；`maxSteps` 限制反馈测试步数。默认检查覆盖身份与特征、合法候选、基线、可重复重置、幂等与状态核对、过期和非法动作、反馈修订、实例隔离及适用的作用域检查点。业务还需为真实规则、并发、网络不确定性和收益计量编写领域测试。

## 参考领域的边界

Kuhn 使用 J/Q/K 三牌、双人底注 1、下注 1、无加注，行动者座位交替。`calling`、`tight`、`random`、`adaptive` 对手用于机制实验，不能代表现实牌局分布。持续竞价每次已确认动作形成检查点，并通过反馈修订演示延迟结算。

这些模拟器的状态保存在内存；默认生成新的 `sessionId`，防止重启实例复用旧轨迹 ID。只在确定性的测试中显式指定固定 `sessionId`，不要用它伪装跨进程恢复。接入实际 bot、交易系统或竞价环境后，需要自己的数据权限、状态恢复、评价器和独立效益实验。
