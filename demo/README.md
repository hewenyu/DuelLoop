# 用公开 SDK 开发自己的应用

这个目录是独立消费项目，所有 SDK 导入均为 `from 'duelloop'`。`market-domain.mjs` 是应用自行实现的持续资源竞价环境，不依赖 Kuhn 或核心私有代码。其规则、私有状态、合法动作、执行核对、延迟结算和策略均由应用拥有。

需要 Node.js 24 或更新版本。安装根项目依赖后，从仓库根目录执行：

```sh
npm pack
npm install --prefix demo --ignore-scripts --package-lock=false
npm --prefix demo start
npm --prefix demo run check
```

也可以独立进入此目录安装和运行：

```sh
# 先在仓库根目录执行 npm pack
cd demo
npm install --ignore-scripts --package-lock=false
npm start
npm run check
```

`package.json` 使用 `../duelloop-0.2.0.tgz`；升级 SDK 时替换为对应发布版本或本地 tarball。整个目录可以复制到其他位置，将该依赖地址改为 tarball 的实际位置后独立安装。

`app.mjs` 演示两种环境：官方 Kuhn 适配器，以及应用自定义竞价环境。各应用注入独立领域、策略与存储，初始化发布，再反复调用 `step()`。执行与反馈通过 SDK 持久记录。这个演示使用内存数据库；长期应用改用 `new SqliteStore('./application.sqlite')`，并为自己的环境实现可恢复状态和执行状态核对。

模型使用显式 `FixtureDecisionModel`，只根据公开输入给出确定性分数，不联网、不计费。它用于检查集成流程，不能证明 Jev 的判断质量、研究收益或实时延迟。接入真实模型时注入 `JevDecisionModel`，通过环境变量读取凭据；不要把密钥写入策略或反馈。

每个生产动作均基于模型回答，单候选也调用模型；模型失败会停止运行，不能自动切换为 fixture。示例中的 fixture 是明确选择的离线测试模型。

自定义环境实现 `DomainDefinition`：声明版本、特征、规则上下文与能力；生成行动者可见观察和有限合法动作；实现执行幂等、状态查询和反馈。`runDomainConformance` 必须针对独立沙箱实例运行，会实际执行动作。报告中的 `skipped` 表示该场景未验证，不是通过。例如本例没有单候选、无候选场景，也没有声明独立评价能力，因此可以开发运行应用，但不能据此自动发布研究候选。

替换领域时先修改 `market-domain.mjs` 和 `myMarketStrategy()`，再运行合规检查。真实应用的反馈可能由消息流异步抵达，使用 `submitFeedback()` 上报；结算修订应保留同一 `feedbackId` 并增加 `revision`，不要覆盖旧证据。

参考模拟领域每次新建实例都会生成独立 `sessionId`，避免重启后把新轨迹误认为旧轨迹。它们不持久化牌局或市场内部状态；SQLite 日志不等于环境检查点。已有环境应持久化自己的检查点和执行核对信息，不能通过重新创建模拟器冒充恢复。
