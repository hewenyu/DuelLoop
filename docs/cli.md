# DuelLoop CLI 与配置

需要 Node.js 24 或更新版本。安装构建产物后使用 `duelloop`；源码开发可使用 `node dist/cli.js`。CLI 只通过配置文件取得应用、作用域、模型、策略、预算与协议，不从本机 pi 配置推断研究权限。

## 从离线应用开始

<!-- duelloop-check:offline-cli:start -->
```sh
duelloop init --dir ./my-app --domain kuhn --application my-app --scope main
duelloop doctor --config ./my-app/duelloop.json
duelloop run --config ./my-app/duelloop.json --steps 20
duelloop status --config ./my-app/duelloop.json
```
<!-- duelloop-check:offline-cli:end -->

`init` 也支持 `--domain auction`。它生成 `duelloop.json`、`strategy.json`、`development.json`、`final.json`，不调用模型、不创建数据库、不覆盖现有文件。示例中的条件阈值、实验规模与资源预算用于演示，不能视为领域最佳参数。

初始化默认使用明确标记为 `fixture` 的本地确定性评分器，研究关闭。首次 `run` 或 `step` 仅在空作用域安装初始策略；之后修改 `strategy.json` 不会悄悄替换已激活策略。快循环在每个实际决策后检查候选的激活边界。自动发布、显式发布与仅候选模式由 `activationMode` 规定。

内置环境保存在进程内。新的 CLI 进程启动新的模拟会话，以不同轨迹 ID 写入同一数据库；它不会恢复上一进程未完成的模拟牌局。真正环境的状态与执行查询由领域适配器持久化。多进程长期运行时，使用一个 `run` 快 worker 和一个 `research-worker` 慢 worker，共享本机 SQLite 文件。

## 配置契约

`schemaVersion` 当前为 `1.0`。未知字段、缺失必要字段和错误类型都会被拒绝。所有文件路径相对于配置文件所在目录；命令行输入/输出路径相对于当前目录。配置中的凭据只能引用环境变量，不接受 `apiKey` 字面量。

主要字段：

| 字段 | 含义 |
| --- | --- |
| `applicationId`、`scopeId` | 应用及策略作用域；同一数据库作用域不能被另一个应用接管 |
| `database`、`strategy` | SQLite 文件与初始策略文件；CLI 不允许临时内存数据库 |
| `storage`（可选） | `maxDatabaseBytes` 限制逻辑 SQLite 数据库大小，`maxArtifactBytes` 限制每个规范 JSON 产物的 UTF-8 字节数 |
| `domain` | 内置 `kuhn` / `auction`，或可信外部 `module` 工厂 |
| `decisionModel` | `fixture` 或配置固定模型 ID 的 `jev` |
| `runtime` | 模式、动作所有者、流 ID、执行步数上限、间隔、决策期限与执行预留 |
| `activationMode` | `explicit`、`automatic_after_validation`、`candidate_only` |
| `evaluation` | 开发/最终协议路径，独立开发评估的截止时间与模型调用上限 |
| `research` | `off`，或含角色、轮次、预算的 `single` / `team` |

`runtime.maxSteps` 是每个配置流的轮次数上限；总决策数最多为 `maxSteps × streamIds.length`。`--steps` 只能缩小该上限。`executionOwner: "host"` 时 CLI 只生成决策，应用宿主负责执行与提交回执；通常 CLI 自运行适配器使用 `framework`。

存储限额未配置时不启用。多个 worker 使用同一限额配置；达到上限返回 `STORAGE_FAILURE`，不会静默删除旧证据或继续执行尚未记账的动作。`maxDatabaseBytes` 不包含 WAL、临时文件和备份，占用整个目录的硬上限需由部署文件系统提供。

`offline` 只允许本地决策夹具并拒绝真实研究调用。`simulation` 允许在模拟环境调用真实模型。`shadow` 不执行领域动作。`live` 要求真实 Jev 与外部领域模块，禁止把内置模拟器宣称为真实环境。

首次尝试真实 Jev 时，先创建独立的模拟应用，在第一次 `run` 前完成下面的模型配置：

```sh
duelloop init --dir ./jev-app --domain kuhn --application jev-app --scope main
```

修改 `jev-app/duelloop.json` 的 `decisionModel`：

```json
{
  "kind": "jev",
  "model": "jev-1.13.0",
  "apiKeyEnv": "TYPESAFE_API_KEY",
  "timeoutMs": 4000
}
```

同时把 `runtime.mode` 改成 `simulation`。`jev-1.13.0` 是本项目已实测的固定版本，实际账号仍需有访问权限；不能使用 `latest`。如果返回的实际模型 ID 与绑定 ID 不一致，运行时拒绝继续使用该版本，需重新绑定和验证。可选 `baseURL` 只接受不含用户名、密码、query、fragment 的 HTTP(S) URL；`deploymentVersion` 可显式固定同名部署的行为版本。端点、超时和部署版本都参与行为绑定。 未显式传入端点时读取 `TYPESAFE_BASE_URL`，再采用官方 `https://api.typesafe.ai`；构造时将有效端点和默认 10000ms 客户端超时固定并纳入指纹。`doctor` 只报告环境变量是否存在，既不验证远端认证，也不输出值。

已经运行过的离线应用，其当前发布绑定了 fixture 模型；只改模型和模式再使用原数据库会得到 `VERSION_INCOMPATIBLE`。独立的 `jev-app` 使用自己的数据库，在首次运行时绑定真实模型。此方法用于建立新的模拟应用，不用于重置已有研究的保留集配额；维护现有应用时保留历史并按新依赖重新验证。

CLI 从进程环境读取 `apiKeyEnv` 指定的凭据，不自动加载 `.env`，也不将 `DUELLOOP_JEV_MODEL` 等实验脚本变量替换到 JSON 中。模型 ID 和角色配置仍需写入 `duelloop.json`。在源码仓库中可以使用以下命令加载本地凭据；在已安装 SDK 的应用目录中，将 `dist/cli.js` 换成 `./node_modules/.bin/duelloop`：

```sh
node --env-file=.env dist/cli.js doctor --config ./jev-app/duelloop.json
node --env-file=.env dist/cli.js run --config ./jev-app/duelloop.json --steps 4
```

第二条命令按真实模型配置发出付费请求。`DUELLOOP_LIVE` 是仓库实验脚本的开关，不是 SDK 或 CLI 的全局禁用开关；普通 CLI 是否调用模型由命令、运行模式和模型配置决定。

CLI 创建的评价协议为 `3.0`：`maxP95DecisionComputeMs` 衡量模拟器中的决策计算，不表示真实 SDK 的端到端时限。完整运行性能需使用实际存储和环境单独测量。

## 接入自己的环境

配置示例：

```json
{
  "kind": "module",
  "path": "./domain.mjs",
  "exportName": "createDomain",
  "options": { "seed": 1, "opponentId": "fixed" }
}
```

工厂接收 `{ applicationId, scopeId, options }`，返回 `{ domain, evaluator? }`。实现示例在 `templates/domain.mjs`，仅依赖公开 `duelloop` SDK。需要研究或评价时必须提供 `EvaluationAdapter`，并确保评价中的特征构建、知识更新和运行时间预算与生产决策一致。

外部模块属于可信应用代码，运行相关命令会加载并执行它。`doctor` 只检查模块文件存在与 JSON 配置，不执行工厂；需要真实领域行为验证时使用公共 `runDomainConformance`，且只能针对可重置的测试环境。静态 doctor 通过不代表领域接入、模型质量或合规测试已通过。

## 单模型与团队研究

单模型配置示例：

```json
{
  "mode": "single",
  "maxRounds": 2,
  "budget": {
    "maxWallTimeSeconds": 600,
    "maxTokensTotal": 60000,
    "maxModelCalls": 12,
    "maxDecisionModelCalls": 10000,
    "maxRepairAttempts": 1
  },
  "roles": {
    "researcher": {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "maxTurns": 16
    }
  },
  "trigger": {
    "settledTrajectories": 1000,
    "cooldownMs": 300000,
    "pollIntervalMs": 5000,
    "snapshotOptions": { "maxDecisions": 1000, "maxFeedback": 1000 }
  }
}
```

此对象替换配置中的整个 `research` 字段；运行模式需允许真实研究，例如 `simulation`。示例与仓库 `.env.example` 的 DeepSeek 配置一致，CLI 命令仍需继承已配置的环境变量或使用上述 Node.js 加载方式。模型仅支持锁定 pi SDK 内置目录；账号是否支持需另行验证。团队配置把 `mode` 改为 `team`，为 `roles` 补齐 `adversary` 和 `integrator`，每个角色同样填写 provider、model、apiKeyEnv、maxTurns；可以选择相同或不同模型。

单模型在一个任务内跨阶段复用会话；团队每个角色使用隔离会话。受控工具和资源加载由框架指定，不加载用户本机 AGENTS、扩展、提示模板、文件编辑或命令工具。角色会话保存在进程内，进程中断后不自动重放未知费用的请求；通过 `research-recover` 将中断任务收敛为终态，再建立新任务。

```sh
duelloop research-create --config ./my-app/duelloop.json --id study-001
duelloop research-run --config ./my-app/duelloop.json --id study-001
duelloop research-status --config ./my-app/duelloop.json --id study-001
```

`research-create` 不调用模型，在任务开始时冻结有限证据窗口与最终协议；先检查最终资源可用性，耗尽返回 `HOLDOUT_UNAVAILABLE`。`snapshotOptions` 可选，每项 1—10000 条，默认各 1000 条。`research-run` 会调用配置的真实 pi，候选实验也可能调用 Jev。模型提出 `no_change` 是合法结果。最终失败/证据不足也是有效实验结论，不会被自动修订成同一保留集上的无限重试。持续 Worker 在资源用尽时记录 `waiting_protocol`，等待应用修改为独立的新协议并重启 Worker；不能只更换 holdout ID 复用种子或提高已注册额度。已创建任务若遭遇额度竞争，返回 `waiting_protocol`，需要基于新协议创建新任务。`status` 中的最后一条 Worker 状态带有时间戳，不表示进程当前仍在运行。

模型 Token 用量依赖供应商返回值。框架限制输出 Token、模型/工具轮次、累计已报告 Token 与后续调用；本次请求的输入消耗只能返回后获知，因此不能承诺绝对账单上限。取消或传输错误可能留下未知费用，日志会明确标记。pi `costUsd` 根据锁定模型目录估算；Jev 只报告 Token，不伪造费用。

持续双 worker 运行：

```sh
# 终端一：运行配置允许的快循环步数；长任务增大配置中的 maxSteps
duelloop run --config ./my-app/duelloop.json
# 终端二：持续观察已结算轨迹，直到 SIGINT/SIGTERM
duelloop research-worker --config ./my-app/duelloop.json
```

`research-worker` 必须配置显式 `trigger`；冷却和已结算轨迹数从持久证据恢复。慢 worker 仅登记候选发布版本，快 worker 在真实边界激活；慢 worker 不用自己的模拟环境实例判断另一个进程的状态。自动激活仍受暂停、版本依赖、当前基线和验证有效性限制。

最终协议的 `maxHoldoutUses` 在多个任务间累计。用尽后不能靠改任务 ID 重用保留集；应准备新的独立评价条件及协议。示例允许一次最终评价，持续研究不会因此自动创建新保留集或扩大预算。

## 命令清单

除 `init`、`restore`、`strategy-diff`、`help`、`version` 外，每个命令均要求 `--config PATH`。

| 命令 | 额外选项与行为 |
| --- | --- |
| `init` | `--dir DIR --domain kuhn\|auction --application ID --scope ID`；生成离线模板 |
| `doctor` | 静态诊断；零模型调用，不导入外部模块，不创建数据库 |
| `run` | 可选 `--steps N`；运行有界快循环 |
| `step` | 可选 `--stream ID`；一个已配置流的一次决策 |
| `status` | 当前发布、持久激活模式/暂停状态、候选阻塞原因、作用域研究任务和待处理执行；不调用模型 |
| `explain` | `--decision ID_OR_DIGEST`；完整决策依据、来源、停止原因、模型用量与动作 |
| `strategy-validate` | 可选 `--file PATH`；使用领域契约编译策略 |
| `strategy-diff` | `--before PATH --after PATH`；语义差异与所需检查类别 |
| `research-create` | 可选 `--id ID`；创建冻结任务，要求已有基线 |
| `research-run` | `--id ID`；运行新任务；输出结论，保留集明细仍为私有 |
| `research-worker` | 按显式 trigger 持续触发研究，SIGINT/SIGTERM 停止 |
| `research-status` | 可选 `--id ID`；查询任务或当前作用域列表 |
| `research-cancel` | `--id ID`；持久记录取消意图；终态不被复活 |
| `research-recover` | `--id ID`；收敛取消或中断任务，不重放远端调用 |
| `evaluate` | `--candidate PATH`；只使用开发协议，保存开发报告，无发布资格 |
| `activate` | `--release DIGEST`；按模式、验证与领域边界显式激活 |
| `pause` / `resume` | 暂停/恢复策略激活；当前动作循环继续使用有效版本 |
| `rollback` | `--release DIGEST`；回到本作用域兼容且验证仍有效的版本 |
| `validation-invalidate` | `--digest VALIDATION_DIGEST --reason TEXT`；撤销本作用域发布所依赖的验证资格 |
| `reconcile` | 查询待确认执行结果；不自动重发结果未知的动作 |
| `backup` | `--output NEW_PATH`；SQLite 一致性备份，不覆盖文件 |
| `restore` | `--input BACKUP --output NEW_DATABASE`；检查并恢复到新路径 |
| `integrity` | 数据库和产物摘要完整性检查 |
| `cleanup` | 默认 dry run；加不带值的 `--apply` 才删除不再引用的快照/行为夹具 |
| `export` | 可选 `--output NEW_PATH`；导出当前作用域公开事件与决策，不导出私有保留集明细 |
| `help` / `--help` | JSON 命令与选项清单 |
| `version` / `--version` | JSON 包版本 |

模型失败会使运行命令以错误退出，停止记录可通过 `explain` 查询；不会自动切换程序动作。修复原因并完成 `reconcile` 后，显式重新运行命令以创建新实例。配置 Schema 仍为 `1.0`；策略 Schema 为 `2.0`，评价协议为 `3.0`。旧发布不能直接在运行时 `duelloop-runtime-4` 下继续使用，迁移要求见[运维说明](operations.md)。

数据库备份和清理属于整个数据库的维护操作，导出与业务查询则限定当前作用域。清理不会删除仍被事件、任务、发布、轨迹或执行记录引用的产物。使用新协议/新基线前保留相关实验的审计证据。

反馈修订不会自动把所有旧验证标成失败。操作人员认定证据失效时使用 `validation-invalidate`；已激活版本若依赖该验证，默认停止新决策，需明确回退到兼容有效版本或建立新验证。框架不会静默绕过验证、切换不兼容模型或重发未知动作。软件回退、策略回退、数据库恢复是三个独立操作。

## 输出与退出码

正常命令在 stdout 输出一行 `{ "ok": true, "command": "...", "data": ... }`；异常在 stderr 输出结构化 `{ "ok": false, "error": { "code": "..." } }`。实验运行完成但未通过时仍返回完整报告，并用退出码 4 表达未满足验证条件。Node 的 SQLite 实验性警告可能写入 stderr，不属于 JSON 业务事件；自动化应解析 stdout，并结合退出码判断。

| 退出码 | 含义 |
| --- | --- |
| `0` | 操作完成；`no_change` 也为合法完成 |
| `1` | 存储、内部错误、失败的恢复/完整性结果或研究错误 |
| `2` | 参数、配置、策略、版本兼容或能力错误 |
| `3` | 冲突、状态过期、未知执行、访问拒绝、激活延期或等待新评价协议 |
| `4` | 验证拒绝，实验失败或证据不足 |
| `5` | 模型错误、超时或预算耗尽 |
| `130` | 用户取消或收到终止信号 |

所有 CLI 命令都拒绝未知与重复参数；不存在隐式网络探测、自动修改凭据或自动发布到外部注册表的步骤。
