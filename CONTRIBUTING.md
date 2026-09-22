# 开发与贡献

使用 Node.js 24，先 `npm ci`，再 `npm test`。测试使用 Node 内置 test runner；TypeScript 开启严格类型检查。修改公开 API 后同时运行 `npm run check:package`，验证独立消费项目的类型、运行和 CLI。

新增领域通过 `DomainDefinition` 和 `EvaluationAdapter` 接口接入，并运行 `runDomainConformance`，不要在核心增加领域名称分支。新增策略语义应同步校验、解释器、行为夹具和问题差异测试。修改研究状态、执行所有权或激活逻辑必须覆盖 docs/implementation.md 对应的竞争与恢复场景。

真实模型实验是显式独立测试，需要使用者自己的凭据和预算；缺少凭据时准确保留未执行状态。不要提交密钥、私有保留集、真实模型的敏感输入或本地数据库。离线测试不得隐式调用付费服务。

项目采用 [MIT 许可证](LICENSE)，保留 `private: true`，尚未发布 npm 包。提交对公共兼容、模型依赖或存储语义的改动时，应在 CHANGELOG.md 记录并提供验证证据。

提交范围：保留可复用代码、测试、空凭据配置示例和使用文档；不提交 `.env`、运行数据库、模型原文、保留集、日志或本机路径清单。`docs/evidence/` 与 `artifacts/` 仅本地保留；可公开的结果整理到 [docs/validation.md](docs/validation.md)。更改文档引用时检查目标是否随 Git 提交，不能依赖本地忽略文件。
