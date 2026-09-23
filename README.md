# DuelLoop

快环临场决策，慢环复盘进化。

DuelLoop 的目标是成为面向对抗博弈的开发者框架：开发者安装 DuelLoop、接入自己的环境、配置 Jev、研究模型和策略，即可开发、运行和维护自己的对抗决策应用。

框架以可执行策略连接两个循环：Jev 根据当前策略与实时局面决定动作，pi 驱动单模型或可配置研究团队提出策略更新，经独立验证后用于后续决策。

当前实现为 `0.1.0` 开发版本，包含 TypeScript SDK、CLI、SQLite 存储、单模型/团队研究、Jev/pi 集成，以及 Kuhn Poker 和持续竞价两个模拟领域。真实服务需要使用者自己的模型凭据；离线演示明确使用 fixture，不证明真实模型的策略效果。当前行为为“模型决策，失败停止”：包括单候选在内，每次动作均调用模型；合法低置信度回答正常消费，模型失败不执行替代动作。此前真实 Jev/pi 闭环和 `no_change` 结果属于旧运行语义，不能作为本轮真实模型验收。可直接使用的能力、实验限制与脱敏验证结果见[能力范围](docs/validation.md)，详细实现见[实施记录](docs/implementation.md)。

## 开始运行

需要 Node.js 24 和 npm。已验证环境为 macOS arm64 / Node.js 24.13.0；内置 `node:sqlite` 可能输出实验性警告。

```sh
npm ci
npm test
npm run demo
```

`npm run demo` 构建并打包当前 SDK，在全新的独立目录安装产物，运行两个应用、公开类型检查和领域合规检查。全程无需密钥，不调用收费模型。

使用 CLI 创建自己的离线应用：

```sh
node dist/cli.js init --dir ./my-app --domain kuhn --application my-app --scope main
node dist/cli.js doctor --config ./my-app/duelloop.json
node dist/cli.js run --config ./my-app/duelloop.json --steps 20
node dist/cli.js status --config ./my-app/duelloop.json
```

## SDK 演示目录

[demo/](demo/README.md) 是保留给使用者的独立 SDK 消费项目。`app.mjs` 只从 `duelloop` 公共入口导入；`market-domain.mjs` 展示应用自己实现环境，不修改核心源码。它支持通过本地 tarball 安装：

```sh
npm pack
npm --prefix demo install --ignore-scripts
npm --prefix demo start
npm --prefix demo run check
```

开发时多次生成相同版本的 tarball 可能命中 npm 缓存；验证当前构建请使用 `npm run check:package`，它每次创建全新安装目录。参考模拟器的环境状态在内存中，SQLite 持久化决策、研究、发布和执行记录；实际环境的恢复与结果查询由领域适配器负责。

## 功能与文档

当前交付为单机开发版本。SDK 与 CLI 可用于应用开发；演示环境、fixture 和受控实验候选不等于生产环境、真实模型或可复用的盈利策略。真实环境的持久化、执行核对和领域效果验证由接入者落实。

- [能力范围与验证摘要](docs/validation.md)：哪些能力可用、哪些仅用于实验，以及本地数据与公开代码的分发边界。
- [SDK 使用](docs/sdk.md)：托管快循环、嵌入已有 bot、宿主执行、反馈和事件。
- [领域接入](docs/domains.md)：有限合法候选、可见状态、能力声明、合规测试和独立评价。
- [CLI 与配置](docs/cli.md)：模型/角色配置、两个 worker、策略检查、研究、激活、回退及诊断。
- [模型与实验](docs/models.md)：真实 Jev/pi、M0 两条模型路径实验、端到端基准和真实闭环验收。
- [运行维护](docs/operations.md)：停止、未知回执、备份恢复、资格失效、数据清理和兼容约束。
- [模型决策与停止契约](docs/model-only-decisions.md)、[架构实施基线](docs/design.md)与[验收记录](docs/implementation.md)：v0.3 目标、I-01—I-05 和 R1—R10。

`npm test` 运行无密钥测试；`npm run test:live` 在未显式启用真实模型时报告跳过。`npm run benchmark` 只测 fixture 下的本地 SDK 与存储开销。真实服务、策略收益和真实并发性能必须单独实测，不能由离线通过推断。

项目采用 [MIT 许可证](LICENSE)。包当前为本地可分发开发产物，保留 `private: true`，尚未发布到 npm。[第三方依赖说明](THIRD_PARTY_NOTICES.md)列出已锁定 SDK 的许可信息。
