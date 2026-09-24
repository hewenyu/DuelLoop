# CLI templates

Run `duelloop init --dir ./my-app --domain auction --application my-app --scope main` to generate an explicit offline configuration, strategy, development protocol, and private final protocol. `init` does not call models or overwrite existing files.

`domain.mjs` is a trusted external factory example using only the public SDK. Copy it into the generated application directory and set:

```json
{"kind":"module","path":"./domain.mjs","exportName":"createDomain","options":{"seed":1,"opponentId":"fixed"}}
```

as `domain` in `duelloop.json`. Match evaluator timing to `runtime.maxDecisionMs` and `runtime.executionReserveMs`. This example remains a simulation; supply your own persistent environment adapter before enabling `live`.

Strategies use schema `2.0`; evaluation protocols use version `3.0` with an explicit decision-computation latency gate. Every runtime action, including a single legal candidate, requires a valid model response. Model failure stops the run; repair the cause, reconcile in-flight execution, and explicitly create a new runtime instance. The generated fixture is an explicit offline model, never a live failure replacement.

See `docs/cli.md` for all commands, model configuration, research budgets, recovery, and data boundaries.
