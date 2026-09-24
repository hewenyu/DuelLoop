# 运行和维护

当前实现采用 TypeScript、Node.js 24 和 SQLite。参考部署是单机应用：快循环调用 `DuelLoop`，慢循环调用 `ResearchOrchestrator` 或 `ResearchWorker`，通过持久产物与发布记录连接。异步 worker 不意味着已提供多机调度、进程沙箱或分布式执行租约。

## 启动和停止

启动前固定应用 ID、策略作用域、领域与模型版本、数据库位置、执行模式和执行所有权。`app.bootstrap()` 仅初始化尚未发布的作用域；恢复已有库时先查 `store.activeRelease(scopeId)`，不要重新生成一个“初始发布”覆盖原状态。

快循环通过 `app.start({ streamIds, maxSteps, intervalMs, signal })` 运行，也可以由自己的调度器调用 `step()`。同一流的并发步骤会被拒绝。`app.status()` 提供运行模式、在途步骤、全部在途异步操作和未核对执行数量。`start({ signal })` 收到取消信号时会主动取消尚未完成的决策请求。

```js
await app.stop({ drain: true, timeoutMs: 5000 });
await app.close();
store.close();
```

`stop()` 停止接收新决策并发出取消信号；默认等待直接 `decide()`、执行准备、执行、反馈、核对和底层请求结束后完成落库。`drain: false` 不等待，也不撤回已经发送给环境的动作。`app.close()` 释放本实例的执行所有权和事件订阅，SQLite 由持有它的应用显式 `store.close()`。共享同一 store 的研究工作应先停止，再关闭数据库。自定义模型忽略取消且仍未结束时，排空超时和 `close()` 会拒绝，实例不会宣称已关闭；保持 store 可用，待请求结束后重试。模型或领域回调内部若需停止，只调用 `stop({ drain: false })`，由外部生命周期拥有者排空，避免等待自身请求。

## 模型失败后的停止与恢复

模型超时、不可达、缺失或非法回答、模型版本不符，以及无合法候选都会停止本次决策。已获得的回答和用量随停止记录保存；错误关联决策 ID，记录的来源为 `stopped`，`stopReason` 表示机器可读原因。没有动作，也不创建这次决策的执行意图。合法低置信度回答正常消费；单候选也必须等待有效模型回答。

模型失败使当前运行实例进入停止状态。重复调用 `start()` 不自动恢复，也不能把失败记录交给执行入口。恢复步骤为：查明并修复原因；核对原环境与已有在途意图；关闭旧实例；显式创建新实例并确认当前发布依赖有效，然后继续运行。多流应用也应阻止尚未发出的动作；停止无法撤销已发给外部环境的其他在途动作。

运行时在真正调用领域执行接口前再次检查停止状态。如果意图已经落库但请求尚未发送，记录 `rejected` 和 `STOPPED_BEFORE_SEND`；已经发送却未确认的请求仍记录 `unknown`，由原环境核对。模型超时后的迟到结果不会恢复运行；存储仍可写时，追加 `decision.late_model_result` 事件保存可获得的用量，原停止记录保持不可变。关闭存储后无法保证收集远端迟到用量。

研究失败、`no_change` 或证据不足只保留当前已验证策略。决策模型健康时快循环可以继续；研究不会向快循环提供程序代打。实验中的模型失败必须中断实验，不能通过舍弃失败样本得到通过结果。

## 未知执行与恢复

执行前先持久化意图，发送后持久化回执。`accepted`、`unknown` 或缺失回执均属于未完成核对；不要为同一业务动作换一个新幂等键重试。

```js
const unresolved = store.unresolvedIntents('policy');
if (unresolved.length) await app.reconcile('policy');
```

`reconcile()` 调用领域的 `executionStatus()`，不会替你再次执行动作。只有领域能证明的结果才可写入回执；缺少查询能力时，由宿主系统完成核对。恢复时必须接回原环境及其持久执行账本，新建一个空白模拟器无法确认旧动作。

SQLite 的执行所有权记录包含主机、进程和令牌；活跃所有者不能被另一实例直接覆盖。接管已死亡进程的流之前先核对未完成意图。跨主机分布式执行、外部租约续期和真实环境 fencing 属于接入系统职责，当前不提供分布式安全保证。

研究通过 `orchestrator.cancel(runId)` 取消。另一个 SQLite 连接或进程发起的取消也会在 Pi 下一次发送请求前检查，包括工具结果续问和 JSON 格式修复；已发送请求不能撤销已发生费用，返回的用量仍保留。内置 Pi 禁用传输层自动重试，防止重试绕过持久取消检查。

进程中断后调用 `orchestrator.recover(runId)`。最终验证报告与 `validated_pending_release` 状态原子保存；之后策略、release 和 `completed_passed` 在同一事务提交。发布写入失败会向调用方抛出故障并保留待发布状态。修复存储后，`recover()` 或 Worker 下一次轮询仅重试本地发布，不再调用模型、重新评估或领取保留集额度，成功后从 `run.data.releaseDigest` 读取发布摘要。重复恢复不会产生重复发布。旧版留下的 `completed_passed` 且缺少 release 的任务也可恢复，但必须保留完整候选和最终验证产物；缺失时明确拒绝。

尚未开始或其他终态的任务保留状态；无法确认远端执行结果、也没有持久最终报告的中途研究进入错误状态并保留已花费预算，不自动重放模型或最终实验。需要新的研究任务时使用新的 run ID，并遵守已有保留集使用额度。

研究结束后释放本轮 Pi 会话、工具闭包和上下文，已持久化的角色输出和证据不删除。同一轮的单模型跨阶段复用、团队角色隔离仍保留。超时或取消时若底层请求尚未结束，先返回停止结果，待迟到用量记录后释放会话；应用关闭共享 store 前应先 `await provider.dispose()` 等待底层结算。自定义研究 provider 及包装器必须透传 `beforeModelRequest`，在每次实际请求前同步调用，并实现或透传 `releaseSession(sessionId)` 释放自己持有的资源。

## 备份、恢复与迁移

```js
await app.stop({ drain: true });
await store.backup('./backups/app-2026-09-22.sqlite');
const check = store.integrity();
if (!check.ok) throw new Error(JSON.stringify(check.issues));

// 先关闭旧应用；恢复目标必须不存在。
const restored = SqliteStore.restore('./backups/app-2026-09-22.sqlite', './restored/app.sqlite');
console.log(restored.integrity());
restored.close();
```

`backup()` 使用 SQLite 备份 API，不直接复制运行中的 WAL 主文件。备份目标必须是新路径。`restore()` 检查备份完整性，复制到不存在的目标并打开；不要直接覆盖当前运行数据库。`integrity()` 检查 SQLite、产物内容摘要以及发布所引用的策略和验证产物。

恢复检查只读打开源文件，验证 SQLite 格式、版本、必要表以及产物引用；空文件、其他应用的 SQLite 库、缺表或带未合并 WAL 的运行库都会拒绝。失败不把源文件初始化成空的 DuelLoop 数据库，也不修改其内容或权限。

当前持久 Schema 版本为 3。空库初始化为 3；Schema 1/2 在写锁内原子迁移，保留历史证据、发布、执行和保留集额度。迁移再次检查版本，两个进程同时打开旧库不会重复修改表。未知较新版本拒绝，也不支持任意降级。升级前保留可读备份，运行安装包检查和本领域回归；依赖改变后重新核对发布绑定。

## 行为版本升级

当前策略 `schemaVersion` 为 `2.0`，评价协议 `version` 为 `3.0`，运行时为 `duelloop-runtime-5`，应用配置 Schema 为 1，SQLite Schema 为 3。协议性能字段改为 `maxP95DecisionComputeMs`，不代表完整 SDK 的 P95。旧策略的 `decision.minRequiredConfidence`、`exitConditions`、`fallback`，旧领域的 `baselineVersion`、`fallback()`，以及评价协议 `maxFallbackRate` 已删除；公开输入中的旧字段不能静默接受。

升级前保留数据库备份与旧实验。历史 JSON 和反馈不做覆盖迁移；旧发布、轨迹绑定及验证报告也不获得新运行资格。使用新策略、新协议及当前行为依赖重新验证和登记发布；需要新的应用/作用域承接时由宿主显式选择，并正确接回环境和处理在途轨迹。不能删除数据库、清零保留集额度或把旧报告改写为新版来完成迁移。最终保留集已使用的实验，需要独立的新评价设计和新数据。

## 双循环调度和发布

`ResearchWorker` 从已结算反馈和持久触发记录判断样本门槛与冷却时间。同一作用域已有未完成研究时不再创建另一轮。构造参数包括 `orchestrator`、`store`、`scopeId`、最终和开发协议、`settledTrajectories`、`cooldownMs`，以及可选 `onRelease` 回调。

默认触发器使用最新反馈修订投影和持久 journal 游标。可显式配置 `feedbackTriggerMode: 'first_settlement'`，只按每条轨迹的首次结算触发，修订仍进入研究快照；默认 `latest_revision` 兼容旧行为。首次结算 ledger 在 Schema 3 迁移时从历史事件补齐，并使用索引查询。首次研究模型调用的预算扣次与触发游标在同一事务提交；相同宿主时间戳、乱序接收时间和新修订都能识别，重复修订不再次触发。空闲轮询只读取索引和汇总，不创建快照或加载全部历史。

研究快照默认保留最新 1000 条决策及 1000 条反馈，可通过 `snapshotOptions: { maxDecisions, maxFeedback }` 调整，每项范围 1—10000。这是滚动窗口：已观察但落在窗口外的旧记录不会逐批重新触发研究；相邻研究的证据窗口允许重叠。触发游标控制新增经验是否足以开新研究，快照在自己的读取事务中固定具体修订。容量限制按字节另行设置，记录数上限不保证产物小于某个字节限额。

```js
const worker = new ResearchWorker({
  orchestrator, store, scopeId: 'policy', protocol: finalProtocol, developmentProtocol,
  settledTrajectories: 100, cooldownMs: 60000,
  snapshotOptions: { maxDecisions: 1000, maxFeedback: 1000 },
});
const controller = new AbortController();
const fast = app.start({ streamIds: ['table-1'], signal: controller.signal });
const slow = worker.run({ signal: controller.signal, pollIntervalMs: 5000 });
process.once('SIGINT', () => {
  controller.abort();
  worker.stop();
});
await Promise.allSettled([fast, slow]);
```

这是 SDK 编排示意；停止信号应接在应用自身的生命周期中。两个循环共享事件循环时，长时间同步业务代码仍会阻塞决策；CPU 密集模拟应由应用放进独立进程或受控 worker。

激活策略由 `store.setActivationMode(scopeId, mode)` 控制，支持 `candidate_only`、`automatic_after_validation`、`explicit`；`store.pauseActivation(scopeId, true)` 暂停切换。通过验证的研究只登记候选发布；托管 `step()` 在边界独立调用 `activatePending(scopeId)`，嵌入应用由自己的边界调度调用它。无需用 `onRelease` 激活；该回调仅作可选通知。正常延期使用 `ACTIVATION_DEFERRED`，候选失效被标记，存储等故障仍向外抛出。边界未到不会结束研究轮询。直接 `activate()` 也区分延期和故障，并再次验证资格与领域边界。回退使用 `await app.rollback(scopeId, targetReleaseDigest)`，同时检查作用域、运行模式、完整验证绑定和领域边界；存储接口属于底层机制，不能代替运行时检查。回退不会改写在途轨迹；曾激活的历史版本不会再被自动调度，若确需重新启用，必须显式调用 `app.activate(digest, true)` 并满足当前基线及验证条件。已激活发布的验证被显式作废后，后续决策会停止，需要恢复兼容且有效的版本或重新验证。数据库通过作用域所属应用绑定拒绝其他应用接管同一作用域。

`store.scopeStatus(scopeId, app.dependencies)` 可读取持久的激活模式、暂停状态、发布状态及阻塞原因。CLI `status` 不载入领域或发起模型调用，因此 `dependenciesChecked: false`，边界标记为 `not_checked`；`lastDeferral` 仅表示最近一次真实激活尝试的延期记录。诊断为 pending 不等于获得提交许可，实际激活仍重新检查依赖与当前边界。

高频网页状态和 worker heartbeat 使用 `store.scopeSummary(scopeId)`：只读取当前 scope 的 active release、激活模式和暂停状态，不开写事务、不遍历历史 release、不执行 eligibility 检查，也不缓存旧值。它只展示状态，不授予激活或执行权限；需要完整发布诊断时继续使用 `scopeStatus`。

研究调用 `protocolAvailability(finalProtocol)` 预检最终资源；额度耗尽时 Worker 的 `status().state` 为 `waiting_protocol`，不调用模型也不消费触发反馈。新建任务会报 `HOLDOUT_UNAVAILABLE`；已创建任务遇到额度被其他研究用尽时进入 `waiting_protocol` 终态。最终阶段仍原子领取额度。协议和配额持久冻结，不能更换 ID 复用同领域种子，也不能增加已注册额度。SDK 用 `worker.updateProtocols({ protocol, developmentProtocol })` 配置独立的新资源；CLI 修改协议文件后重启研究 Worker。已有任务的协议不被替换。CLI `status` 显示带时间戳的最后一条 Worker 资源状态；它不是进程心跳。

## 资源、数据和信任范围

可以使用 `new SqliteStore(path, { maxDatabaseBytes: 268435456, maxArtifactBytes: 4194304 })` 为当前连接设置逻辑数据库与单个产物限额；数值只是配置示例。每个 worker 必须传入相同配置，未传时不增加限额。数据库限额按 SQLite 页大小向下取整，不能小于已有数据；限额耗尽返回 `STORAGE_FAILURE`，保留已有证据并拒绝新写入。它不包含 WAL、临时文件、备份和进程内存，整个部署目录的硬配额由文件系统提供。

解释器限制维度 16、分支 64、条件深度 12、条件总节点 256、展开问题 512、模型上下文 128KiB。研究有墙钟时间、Token、角色调用、决策模型调用、修复次数、轮数、开发评估和最终评估额度。用量的 `unknown` 仅表示 Token 不完整；`costUnknown` 表示费用不完整，`knownCostUsd` 是已知费用小计。只有全部调用费用已知时才输出总额 `costUsd`。Jev 只返回 Token 时保留准确 Token 和未知费用；显式返回零费用才是已知零费用。

这些是逻辑预算，不是操作系统内存配额。诊断/导出列表和实验明细仍可能进入进程内存；热路径已经按作用域、流、状态查询，研究快照有界。大量历史仍需应用制定保留、分页读取、归档与资源隔离方案。`events({ scopeId, afterId, types, limit })` 支持持久游标分页；显式请求历史 cutoff 的反馈修订回溯比当前快照昂贵。`store.pruneUnreferencedArtifacts({ dryRun: true })` 可预览未被引用的可清理产物，默认仅处理快照和行为夹具；执行清理前备份，再显式传 `dryRun: false`。清理保护事件、研究任务、发布和在途执行引用，不用于强行清空全部历史。完整 SDK 的历史规模/同库争用验收见[工程化修复](engineering-reliability.md)与[验证记录](validation.md)。同步 SQLite 和同步业务代码不能被异步超时硬抢占；需要按实际时限隔离进程并验证。不要手动删除当前发布或验证结论唯一依赖的证据，否则回放与复核能力会丢失。

研究模型通过受控工具读取开发证据、提出候选和运行开发实验。pi provider 不扫描本机默认扩展、技能、上下文文件或默认命令工具。领域、存储、模型适配器和显式工具实现属于受信任程序代码；`private` 产物标志是研究工具的数据隔离，不是对数据库拥有者的加密或强制访问控制。

凭据通过环境变量或明确的内存配置注入。数据库含观察、模型输入输出和反馈，按应用数据政策限制文件访问与保存时间。Node.js SQLite 会发出实验性 API 提示；是否符合生产运行环境要求由应用验证。

## CLI

安装后的 `duelloop --help` 和 `duelloop --version` 输出 JSON。命令完整说明见 [CLI 文档](cli.md)。首次本地试运行：

```sh
duelloop init --dir ./my-app --domain kuhn --application my-app --scope policy
duelloop doctor --config ./my-app/duelloop.json
duelloop run --config ./my-app/duelloop.json --steps 4
```

`doctor` 默认只做配置与能力诊断，不加载外部领域模块或调用付费模型。CLI 提供策略检查、研究创建/运行/取消/恢复、实验、发布激活/暂停/回退、执行核对、备份/恢复、完整性检查、导出及清理。具体参数以当前安装版本的帮助和 CLI 文档为准。
