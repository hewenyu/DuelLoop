# DuelLoop 实施跟踪与验收证据

当前工程契约以 [0.2.0 持续运行修复](engineering-reliability.md)和[验证记录](validation.md)为准；下文保留设计与历史实施上下文。

当前行为基线：[模型决策，失败停止](model-only-decisions.md)及[修订设计](design.md)。策略 Schema 为 `2.0`，评价协议为 `3.0`，运行时为 `duelloop-runtime-4`。每个执行动作依赖当次模型回答；失败持久记录并停止，单候选不跳过模型。

2026-09-23 的模型决策修订通过 147 项离线测试及独立安装检查：57 个公开类型、12 步 SDK 演示、安装包文档和领域模板均验证。领域合规 11 项通过、2 个未提供可选场景跳过；该次未调用收费模型。当前 0.2.0 工程修复通过 184 项离线测试，完整范围见[当前验证摘要](validation.md)。

截至 2026-09-22，首个 `0.1.0` 开发实现已具备公开 SDK、CLI、模型适配、双循环、SQLite、领域扩展和独立消费演示。已完成 v0.3 定义的旧语义首版本地交付与受控模拟验收，可从源码构建、本地打包、安装并运行；这是单机开发版本，尚未发布到 npm，也不表示任意真实业务环境已达到生产要求。

项目已采用 [MIT 许可证](../LICENSE)，保留 `private: true`，尚未发布到 npm。真实 `jev-1.13.0` 的 Score/Choice 调用及通过 pi 使用 `deepseek-flash` 的受控工具调用已通过，可公开结果见[验证摘要](validation.md)；原始模型输出与本机验收数据仅在本地保存。这是旧语义下的连接证据，本轮未重新调用真实服务；真实顺序和并发性能另行测量，研究收益仍需独立实验判断。接口使用锁定的官方 SDK；夹具、本机 HTTP/SSE 和真实服务证据分别记录。

## 已交付的工程能力

| 范围 | 实现入口 | 可观察结果 |
| --- | --- | --- |
| 策略工具链 | `src/strategy.ts` | 严格策略语义、2—10 级 Score、条件、权重、问题映射、版本差异、归一化、argmax/softmax |
| 快循环与执行 | `src/runtime.ts` | 托管或宿主执行、统一模式检查、截止时间、模型失败停止、意图/回执、未知执行核对 |
| 持久化 | `src/storage.ts` | SQLite WAL、事务任务领取、预算、内容摘要、私有证据、反馈修订、轨迹绑定、激活 CAS、备份恢复及清理 |
| 研究与实验 | `src/research.ts`、`src/evaluation.ts`、`src/worker.ts` | 单模型/团队编排、正式候选提交、行为检查、开发/保留隔离、统计验证、取消与恢复、反馈触发 |
| 模型适配 | `src/adapters.ts` | Jev Score/实验 Choice、pi 受控会话和工具、用量与未知用量记录 |
| 开发者工具 | `src/config.ts`、`src/cli.ts`、`templates/` | 初始化、严格配置、诊断、双 worker、策略及研究操作、发布、解释、维护命令 |
| 领域与公开接入 | `src/domains.ts`、`src/conformance.ts`、`demo/` | Kuhn Poker、持续竞价、应用自有市场适配器、可选能力合规检查、公开类型消费 |
| 分发 | `package.json`、`scripts/check-package.mjs` | ESM 根入口、类型声明、CLI bin；独立临时项目安装当次 tarball，禁止私有深层导入 |

`demo/` 仅导入 `duelloop`，可以复制成自己的 SDK 应用。`npm run demo` 会打包、在仓库外安装并执行演示；不是通过工作区私有源码绕过安装验证。演示模型明确标记为 fixture，不需要密钥。

## I-01—I-05 实施结果

| 编号 | 实现和本地验证 | 证据入口 |
| --- | --- | --- |
| I-01 取消一致性 | 持久状态决定能否推进；跨 worker 取消后晚到响应仍记录已知用量，但不得提交、复活或发布；零剩余 Token 不启动新评价调用 | `test/research.test.mjs`、`test/core.test.mjs` |
| I-02 多流版本绑定 | 默认发布与在途轨迹分别保存；重开库保留绑定；回退不改变在途版本，也不自动重新激活已用过的旧候选 | `test/core.test.mjs` |
| I-03 随机化行为检查 | 检查完整分布、种子回放与采样统计；实验与 SDK 对显式采样种子、时间预算采用同一规则 | `test/core.test.mjs`、`test/domains.test.mjs` |
| I-04 统一执行检查 | 仅接受有效模型策略动作，单候选也调用模型；停止记录与旧非模型来源被拒绝；宿主/影子不隐式执行；数据库原子领取意图，重复并发提交不能发送两次 | `test/core.test.mjs`、`test/process-recovery.test.mjs` |
| I-05 当前激活资格 | 激活、回退检查当前验证资格、完整绑定、运行模式、作用域、依赖及领域边界；已激活验证撤销后停止新决策 | `test/core.test.mjs`、`test/cli.test.mjs` |

補充验收覆盖公开类型的完整声明树、从 tarball 提取执行文档中的完整 SDK/CLI 示例和领域模板、同时间戳反馈及修订触发、空白/异域备份拒绝、配额耗尽后现有证据保留。

这些是已执行的本地机制验证，不表示已穷尽所有生产故障组合。新增真实子进程测试覆盖两个 worker 竞争研究任务，以及外部环境接受动作后进程立即退出、重启仅核对不重发的场景。

## R1—R10 历史证据索引（2026-09-22）

下表记录旧运行语义的验收。新语义需要本轮独立验证；真实调用、收益与性能不可从旧报告继承。

| 编号 | 当前结论 | 证据 | 剩余条件或限制 |
| --- | --- | --- | --- |
| R1 分发与离线开始 | 本地分发、严格类型及安装包文档示例通过 | `scripts/check-package.mjs`、CLI 测试、[分发验证摘要](validation.md) | 项目采用 MIT；尚未发布到公共 npm |
| R2 真实 Jev/pi 闭环 | 真实 pi 自主提出、真实 Jev 独立验证、激活及 20 次后续步骤完成 | [受控闭环摘要](validation.md)、`test/live/closed-loop.test.mjs` | 受控被动初始策略；未证明正常基线或接入其他 bot 后也会改善 |
| R3 单模型/团队 | 真实三阶段完成：single 复用 1 会话，team 使用 3 隔离会话；两次均为 `no_change` | [研究方式验证摘要](validation.md)、研究/适配器测试 | 使用同一个 Pro 模型承担角色；未证明团队带来收益，Jev 美元费用未知 |
| R4 外部异构接入 | 独立 tarball 消费通过 | `demo/market-domain.mjs`、公开类型及领域合规检查 | 演示环境为模拟市场，无真实交易连接 |
| R5 验证拒绝与保留隔离 | 本地通过 | 研究/评价测试 | 不证明具体策略在真实领域提升收益 |
| R6 初始化、激活与回退 | 本地通过；持久暂停、模式和阻塞原因可查询 | core/CLI/worker 测试 | 验证失效由应用显式触发，不自动识别所有业务退化 |
| R7 执行与恢复 | 本地故障与子进程测试通过 | core/process-recovery 测试 | 实际环境必须提供持久幂等账本和状态查询；不承诺分布式恰好一次 |
| R8 可观测与隔离 | 本地通过 | CLI 解释/导出、研究工具私有证据隔离、跨应用作用域测试 | 数据库拥有者和适配器代码受信任，私有标记不是加密或租户沙箱 |
| R9 维护与升级 | Schema 1 只读备份校验、恢复及存储限额通过 | core/CLI/storage-maintenance/storage-limits 测试、[运维说明](operations.md) | 0.2.0 新增 Schema 1→2 原子迁移与并发迁移回归；不支持任意降级 |
| R10 性能与费用 | fixture 与真实 Jev 的顺序、三路径和三次并发测量已执行 | [测量摘要与限制](validation.md)、`scripts/benchmark.mjs`、`scripts/concurrency-benchmark.mjs` | 小规模描述性结果；Jev 美元价格未返回，部分历史失败调用 token 未知，不能解释为零费用或容量承诺 |

公开仓库保留[验证摘要](validation.md)、测试和复现脚本。完整模型输出、保留集记录、日志及机器专属验收摘要保存在被 Git 忽略的本地 `docs/evidence/` 和 `artifacts/` 中，不随源码提交或安装包分发。旧实验对应当时源码及参数，不把其结果追溯绑定到后续提交。

## 历史阶段判断（2026-09-22）

- M0：真实三路径对照完成，每条路径 45 手；这组小样本未显示 Score 优于 Choice，示例阈值 0.55 下 Score 降级率约 81%。
- M1：快循环实现、公开接口、本地故障测试及真实 SDK step 测量完成；30 个实测步骤 p95 约 1.20 秒，不能外推为其他环境的时延保证。
- M2：真实 pi 提交 `k-call-guard-v1`，真实 Jev 的独立保留评估通过，随后激活并完成 20 次 SDK 步骤；16 个可比较局面中 6 个动作分布改变。受控实验相对被动初始策略每手平均增加 0.2222 筹码，95% 下界 0.1200；这不是正常应用收益保证。
- M3：单模型与团队会话、工具、预算及取消恢复实现完成；真实三阶段和隔离会话已确认。正常基线研究均返回 `no_change`，开发实验不足以支持改进；费用已记录，不能据单次运行推荐团队优于单模型。
- M4：第二领域、应用自有领域、独立安装、类型和 CLI 消费验证完成。
- 首版交付：v0.3 定义的 SDK、CLI、领域扩展、维护、独立分发及真实模型能力验收完成，以 `0.1.0` 本地产物交付。MIT 已确定；npm 公共发布与远程 CI 未执行。

允许 `no_change`、验证拒绝或证据不足。真实受控更新实验未通过时保留当前策略和预定评价标准，不为了完成里程碑强制生成新版本。

## 复现本地验收

```sh
npm ci
npm test
npm run check:package
npm run test:live
node scripts/benchmark.mjs --fixture --steps 1000 --output /tmp/benchmark.json
node scripts/m0.mjs --fixture --hands 20 --output /tmp/m0.json
node scripts/concurrency-benchmark.mjs --fixture --repetitions 3 --steps 100 --warmup 5 --slow-runs 100 --slow-hands 8 --wall-seconds 30 --output /tmp/concurrency.json
```

真实服务配置和预算见 [模型说明](models.md)。在本机安全配置 `TYPESAFE_API_KEY`、固定的 `DUELLOOP_JEV_MODEL`、`DUELLOOP_PI_PROVIDER`、`DUELLOOP_PI_MODEL`、`DUELLOOP_PI_KEY_ENV` 及其引用的环境变量；启用 `DUELLOOP_LIVE=1`，受控闭环另需 `DUELLOOP_LIVE_CLOSED_LOOP=1`。不要把密钥写入仓库或报告。

已知运行边界：单机 Node.js 24 + SQLite；参考模拟器环境状态在内存中；不提供多机租约、管理后台、模型权重训练或任意代码策略。领域、模型和研究工具实现均为受信任扩展代码。框架逻辑预算不能保证远端服务绝不超收已经在途的调用，未知用量不会被写成零费用。
