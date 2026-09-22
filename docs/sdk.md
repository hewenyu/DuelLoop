# SDK 接入

DuelLoop 目前为 `0.1.0` 本地分发包，采用 [MIT 许可证](../LICENSE)，Node.js 要求为 24 或更新版本，模块格式为 ESM。`package.json` 保留 `private: true`，尚未发布到公共 npm。仓库构建后运行 `npm pack`，在自己的项目中安装得到的 `.tgz`。

```sh
npm install /absolute/path/duelloop-0.1.0.tgz
```

应用使用 `import ... from 'duelloop'`。包只导出根入口，不支持 `duelloop/dist/...` 或仓库 `src/...` 路径。`demo/` 是可复制的消费项目；`npm run check:package` 会将当次 tarball 装入独立临时项目，运行 SDK、领域合规、公开类型和 CLI 检查。

## 托管运行

框架拥有执行权时，`step()` 读取观察、选择动作、核对状态、记录执行意图、调用环境，再收集反馈。

<!-- duelloop-check:managed-sdk:start -->
```js
import {
  DuelLoop, SqliteStore, KuhnPokerDomain, createKuhnStrategy,
  FixtureDecisionModel,
} from 'duelloop';

const store = new SqliteStore('./app.sqlite');
const domain = new KuhnPokerDomain({ applicationId: 'my-app', scopeId: 'policy', seed: 7 });
const model = new FixtureDecisionModel('local-smoke-fixture', question => ({
  score: 0,
  confidence: 1,
  probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])),
}));
const app = new DuelLoop({
  applicationId: 'my-app', domain, model, store,
  mode: 'offline', executionOwner: 'framework',
  maxDecisionMs: 5000, executionReserveMs: 25,
});
try {
  if (!store.activeRelease('policy')) app.bootstrap(createKuhnStrategy(), 'policy');
  const { decision, receipt } = await app.step('table-1');
  console.log(decision.action, decision.decisionSource, receipt?.status);
} finally {
  await app.close();
  store.close();
}
```
<!-- duelloop-check:managed-sdk:end -->

这是规则环境与 SDK 集成演示，夹具分数不证明模型表现。参考模拟器的牌局与执行核对状态在内存中，重建实例会生成新的会话命名空间，不能恢复之前进行中的牌局。长期应用的环境恢复要求见 [运维说明](operations.md)。

`app.start({ streamIds, maxSteps, intervalMs, signal })` 运行有界或持续快循环。一次 `step()` 返回 `{ decision, receipt }`；`decisionSource` 为 `strategy`、`domain_baseline`、`forced_action` 或 `abstain`。动作为空时没有执行回执。`subscribe(listener)` 返回取消订阅函数；持久事件有独立 ID，消费者按 ID 去重。

| 模式 | 行为 |
| --- | --- |
| `offline` | 仅允许显式夹具模型；框架仍可执行所注入的沙箱环境 |
| `simulation` | 可使用真实模型，动作执行在注入的模拟环境中 |
| `shadow` | 计算并记录决策，框架不调用执行接口 |
| `live` | 要求真实决策模型；必须由应用接入真实环境并明确执行所有权 |

模式不把任意适配器变成沙箱。领域代码属于受信任应用代码，注入真实执行适配器之前应按应用本身的部署流程确认模式和凭据。

## 嵌入现有应用

宿主拥有环境循环和执行权时，注入 `executionOwner: 'host'`，调用 `decide(observation, candidates?)`。不传候选动作时，SDK 调用领域的 `candidates()`。执行前调用 `prepareHostExecution()` 核对环境版本、取得唯一执行所有权并持久化执行意图；宿主再调用自己的业务环境执行，并提交回执和反馈：

```js
const app = new DuelLoop({ applicationId, domain, model, store, mode: 'simulation', executionOwner: 'host' });
const decision = await app.decide(observation, candidates);
if (decision.action) {
  const command = await app.prepareHostExecution(decision);
  // 此调用由宿主执行；prepareHostExecution 本身不会发送动作。
  const receipt = await domain.execute(command);
  app.recordHostReceipt(decision, receipt);
}
await app.submitFeedback(feedbackEvents);
```

`prepareHostExecution()` 只创建经核验且已持久化的命令，`recordHostReceipt()` 记录该意图的实际结果。宿主必须使用该命令和幂等键执行；未知结果应先核对，不能自行换键重发。影子模式不能准备执行，宿主模式不能调用框架的 `executeDecision()`。`DecisionRecord` 包含实际发布摘要、模型种类、输入、问题、回答、效用、动作概率及降级来源，可用于定位动作变化。

## 模型与策略

真实 Jev 使用 `new JevDecisionModel({ model: '明确的模型版本', apiKeyEnv: 'TYPESAFE_API_KEY' })`。可选 `baseURL`、`timeoutMs` 用于应用指定的端点与客户端限制。实际请求还受 SDK 决策截止时间限制。不要把密钥写入策略、配置产物或事件。`FixtureDecisionModel` 与 `JevDecisionModel` 的 `kind` 分别为 `fixture`、`real`，报告保留这一区别。

Jev 适配器对 Score / Choice 返回概率统一检查标签、有限值及 `[0,1]` 范围；概率和与 1 的偏差不超过 `0.01`（另计浮点运算误差）时，按实际总和归一化后交给运行时，超出则拒绝。模型原始 `score`、`confidence` 保持不变，也不改变策略的置信度门槛。决策记录中的回答概率因此是归一化值。

`compileStrategy(strategy, domain)` 验证策略并返回稳定摘要；`validateStrategy()`、`diffStrategies()`、`buildQuestions()`、`evaluateAnswers()` 也从根入口导出。当前策略语言仅消费逐候选 `Score`，每个维度包含 2—10 个具体等级、评分语义和权重。Jev 的 Choice 适配接口可用于对照实验，不属于当前可演化策略的执行公式。

`evaluateAnswers()` 默认按当前时间检查局面是否过期，也可通过第六个参数 `evaluatedAt` 指定重放时钟。候选行为夹具固定使用观察的 `observedAt`，因此保存的案例不会仅因时间流逝改变检查结果；现场决策仍按实际截止时间处理。

不要原地修改已发布对象来更新行为。候选应是新的完整 `StrategyPackage`，通过 `CandidateSubmission` 绑定研究快照、基线发布、假设、证据和行为断言。问题或输入投影变化时，旧回答夹具不能证明新问题的行为。`0.55` 是示例置信度阈值，需要用领域数据校准。

## 反馈与研究

`submitFeedback(event | events)` 接收即时、延迟或修订反馈；不传参数则调用领域的 `feedback()`。`feedbackId` 在修订间保持稳定，`revision` 单调增加；`eventTime` 表示事实发生时间，`receivedAt` 表示系统收到该修订的时间。研究快照引用截止时刻可见的具体修订，后续修订不改变已有快照。

`ResearchOrchestrator` 接收 `store`、`domain`、`model`、`evaluator`、`dependencies` 与研究 `providers`。`dependencies` 使用实际应用的 `app.dependencies`，不要自行省略特征构建、基线、续打规则和运行时间预算。评价器必须声明实际执行的 `decisionPolicy`；内置评价器接受与应用一致的 `{ maxDecisionMs, executionReserveMs, randomSeed? }` 构造参数。公开 SDK 会在模型调用前拒绝不匹配的评价预算或采样种子。`create({ scopeId, protocol, developmentProtocol })` 在开始前冻结最终评价协议；开发与保留评价必须采用不同种子与不同 `holdoutId`。

```js
const provider = new PiResearchProvider({ provider: '应用选择的provider', model: '明确的模型ID', apiKeyEnv: 'RESEARCH_API_KEY', maxTurns: 12 });
const researcher = new ResearchOrchestrator({
  store, domain, model, evaluator, dependencies: app.dependencies,
  mode: 'single', providers: { researcher: provider },
  budget: { maxWallTimeSeconds: 600, maxTokensTotal: 60000, maxModelCalls: 12, maxDecisionModelCalls: 10000, maxRepairAttempts: 1 },
});
const run = researcher.create({ scopeId: 'policy', protocol: finalProtocol, developmentProtocol });
const result = await researcher.run(run.id);
if (result.releaseDigest) await app.activate(result.releaseDigest);
```

上例的 `PiResearchProvider`、`ResearchOrchestrator` 需从 `duelloop` 导入；协议及评价器由应用提供，真实研究会产生模型费用。单模型模式复用一个会话跨研究、对抗和整合阶段；团队模式为三个角色分别提供 provider，框架使用独立角色会话。同一模型也可供不同角色使用。

研究工具 `query_experience` 默认返回 5 条摘要，可按种类和偏移分页（每页最多 20 条），也可用 `evidenceRef` 读取完整冻结记录或指定字段。分页不会改变研究快照，引用其他快照中的记录会被拒绝。这样模型可以逐步查阅观察、合法动作、回答和反馈修订，避免每次加载全部历史。

自定义评价器同时声明 `decisionPolicy` 和 `domainDependencies`。后者是实际实验领域的规则、特征构建、知识更新、降级基线、参考续打版本及上下文摘要；它们必须与 `app.dependencies` 对应部分完全一致。应用修改领域基线或上下文后，默认内置评价器不能继续为它生成验证结论。

`run()` 可返回 `no_change`、`completed_failed`、`completed_inconclusive`、预算耗尽或取消。只有通过最终验证才登记研究发布，登记不等于激活。最终失败结束该轮，不会无限反复优化同一保留集。`app.activate()` 还会核对基线摘要、依赖、激活模式和领域边界。

## 兼容范围

| 契约 | 当前支持 | 不兼容时的处理 |
| --- | --- | --- |
| npm SDK | `0.1.0` 开发版，ESM，Node.js 24 | 当前 API 仍可能调整；V1.0 后遵循 SemVer |
| 应用配置 | `schemaVersion: "1.0"` | 拒绝未知版本、字段和非法组合 |
| 策略 | `schemaVersion: "1.0"`，Score | 拒绝新语义、未知领域特征和不匹配的契约版本 |
| 评价协议 | `version: "1.0"` | 创建研究前校验并固定摘要，不能事后换门槛 |
| SQLite | `user_version = 1` | 空库初始化；未知较新版本拒绝；恢复仅接受完整 Schema 1 备份 |
| 领域、模型及运行器 | 发布绑定中的完整行为依赖 | 依赖改变拒绝沿用既有验证，需重新评价 |

升级前保留备份，核对变更记录及上述契约，使用新安装包执行本领域回归和 `check:package`。影响决策行为的运行器修改必须更新 `RUNTIME_VERSION`；仅保持策略 JSON 不变不能说明升级兼容。开发工作区的未提交构建记录额外保存源文件清单与 tarball 摘要，不当作可互换的正式发布。
