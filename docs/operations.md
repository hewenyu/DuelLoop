# 运行和维护

当前实现采用 TypeScript、Node.js 24 和 SQLite。参考部署是单机应用：快循环调用 `DuelLoop`，慢循环调用 `ResearchOrchestrator` 或 `ResearchWorker`，通过持久产物与发布记录连接。异步 worker 不意味着已提供多机调度、进程沙箱或分布式执行租约。

## 启动和停止

启动前固定应用 ID、策略作用域、领域与模型版本、数据库位置、执行模式和执行所有权。`app.bootstrap()` 仅初始化尚未发布的作用域；恢复已有库时先查 `store.activeRelease(scopeId)`，不要重新生成一个“初始发布”覆盖原状态。

快循环通过 `app.start({ streamIds, maxSteps, intervalMs, signal })` 运行，也可以由自己的调度器调用 `step()`。同一流的并发步骤会被拒绝。`app.status()` 提供运行模式、在途步骤和未核对执行数量。

```js
await app.stop({ drain: true, timeoutMs: 5000 });
await app.close();
store.close();
```

`stop()` 停止接收新步骤；默认等待已开始的步骤完成。`drain: false` 不等待，但不撤回已经发送给环境的动作。`app.close()` 释放本实例的执行所有权和事件订阅，SQLite 由持有它的应用显式 `store.close()`。共享同一 store 的研究工作应先停止，再关闭数据库。

## 未知执行与恢复

执行前先持久化意图，发送后持久化回执。`accepted`、`unknown` 或缺失回执均属于未完成核对；不要为同一业务动作换一个新幂等键重试。

```js
const unresolved = store.intents('policy').filter(intent =>
  !intent.receipt || ['unknown', 'accepted'].includes(intent.receipt.status)
);
if (unresolved.length) await app.reconcile('policy');
```

`reconcile()` 调用领域的 `executionStatus()`，不会替你再次执行动作。只有领域能证明的结果才可写入回执；缺少查询能力时，由宿主系统完成核对。恢复时必须接回原环境及其持久执行账本，新建一个空白模拟器无法确认旧动作。

SQLite 的执行所有权记录包含主机、进程和令牌；活跃所有者不能被另一实例直接覆盖。接管已死亡进程的流之前先核对未完成意图。跨主机分布式执行、外部租约续期和真实环境 fencing 属于接入系统职责，当前不提供分布式安全保证。

研究通过 `orchestrator.cancel(runId)` 取消。进程中断后调用 `orchestrator.recover(runId)`：尚未开始或已结束的任务保留状态；无法确认远端执行结果的中途研究进入错误状态并保留已花费预算，不自动重放模型或最终实验。需要新的研究任务时使用新的 run ID，并遵守已有保留集使用额度。

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

当前持久 Schema 版本为 1。打开空库时创建版本 1，打开更高版本时拒绝。当前没有需要迁移的历史生产 Schema，也不支持任意降级；“迁移检查”不表示已验证未来所有版本可互转。升级前保留可读备份，运行安装包检查和本领域回归；依赖改变后重新核对发布绑定。

## 双循环调度和发布

`ResearchWorker` 从已结算反馈和持久触发记录判断样本门槛与冷却时间。同一作用域已有未完成研究时不再创建另一轮。构造参数包括 `orchestrator`、`store`、`scopeId`、最终和开发协议、`settledTrajectories`、`cooldownMs`，以及可选 `onRelease` 回调。

触发器将上次研究的冻结快照与当前反馈的 `feedbackId`、`revision` 比较。同一接收时间戳的新事件和新修订都能计入新证据；重复消费同一修订不会再次触发。尚未达到研究门槛的轮询不持续创建历史快照。

```js
const worker = new ResearchWorker({
  orchestrator, store, scopeId: 'policy', protocol: finalProtocol, developmentProtocol,
  settledTrajectories: 100, cooldownMs: 60000,
  onRelease: releaseDigest => app.activate(releaseDigest),
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

激活策略由 `store.setActivationMode(scopeId, mode)` 控制，支持 `candidate_only`、`automatic_after_validation`、`explicit`；`store.pauseActivation(scopeId, true)` 暂停切换。通过验证的研究只登记候选发布，激活需调用运行时并再次验证资格与领域边界。回退使用 `await app.rollback(scopeId, targetReleaseDigest)`，同时检查作用域、运行模式、完整验证绑定和领域边界；存储接口属于底层机制，不能代替运行时检查。回退不会改写在途轨迹；曾激活的历史版本不会再被自动调度，若确需重新启用，必须显式调用 `app.activate(digest, true)` 并满足当前基线及验证条件。已激活发布的验证被显式作废后，后续决策会停止，需要恢复兼容且有效的版本或重新验证。数据库通过作用域所属应用绑定拒绝其他应用接管同一作用域。

`store.scopeStatus(scopeId, app.dependencies)` 可读取持久的激活模式、暂停状态、发布状态及阻塞原因。CLI `status` 不载入领域或发起模型调用，因此 `dependenciesChecked: false`，边界标记为 `not_checked`；`lastDeferral` 仅表示最近一次真实激活尝试的延期记录。诊断为 pending 不等于获得提交许可，实际激活仍重新检查依赖与当前边界。

## 资源、数据和信任范围

可以使用 `new SqliteStore(path, { maxDatabaseBytes: 268435456, maxArtifactBytes: 4194304 })` 为当前连接设置逻辑数据库与单个产物限额；数值只是配置示例。每个 worker 必须传入相同配置，未传时不增加限额。数据库限额按 SQLite 页大小向下取整，不能小于已有数据；限额耗尽返回 `STORAGE_FAILURE`，保留已有证据并拒绝新写入。它不包含 WAL、临时文件、备份和进程内存，整个部署目录的硬配额由文件系统提供。

解释器限制维度 16、分支 64、条件深度 12、条件总节点 256、展开问题 512、模型上下文 128KiB。研究有墙钟时间、Token、角色调用、决策模型调用、修复次数、轮数、开发评估和最终评估额度。未知费用保留为未知，不当作零费用。

这些是逻辑预算，不是操作系统内存配额。SQLite 查询、研究快照和实验明细可能进入进程内存；大量历史需要应用制定保留、分页读取、归档与资源隔离方案。`store.pruneUnreferencedArtifacts({ dryRun: true })` 可预览未被引用的可清理产物，默认仅处理快照和行为夹具；执行清理前备份，再显式传 `dryRun: false`。清理保护事件、研究任务、发布和在途执行引用，不用于强行清空全部历史。当前没有无限规模保证。不要手动删除当前发布或验证结论唯一依赖的证据，否则回放与复核能力会丢失。

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
