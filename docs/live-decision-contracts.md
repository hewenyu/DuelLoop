# Live host decision contracts (0.2.2)

Design recorded before implementation, 2026-09-24. Baseline: DuelLoop
`cba13bb69453f7ea2cd7a79db9d3fbe9859eabc4` (0.2.1). This change supports a
host-owned event-driven runtime; it does not add another environment polling loop.

## Decisions and authority

`decide(observation, candidates?, { signal?, modelDeadline? })` accepts a per-call
cancellation signal and an absolute model deadline. `observation.deadline` remains
the environment's authority deadline and is never shortened in the saved decision.
The effective `DecisionRecord.modelDeadline` is the minimum of the caller's model
deadline (if supplied), authority minus execution reserve, and call start plus
`maxDecisionMs` minus execution reserve. This cap never resets an earlier caller
budget. `prepareHostExecution` continues checking the original authority deadline.
Runtime dependency version changes to 5 so old release validation cannot silently
claim compatibility with the new timing contract.

A caller-aborted decision is persisted as stopped with CANCELLED and emits
`decision.cancelled`. It must not create an intent, poison the runtime, stop other
streams, or permit late results to replace the immutable stopped record. Genuine
model failures, model deadline expiry, or identity mismatch retain fatal stop
semantics. Global stop continues cancelling the lifecycle. Late model usage stays
in separate diagnostics. Hosts remain responsible for per-stream serialization,
authority invalidation, and final pre-send checks.

## Early trajectory binding

`pinTrajectory({ strategyScopeId, streamId, actorId, trajectoryId })` binds the
application scope, validates the release against runtime dependencies, and returns
the durable release digest before the first decision. Repeated calls return the
same binding across activation and restart. `lookupTrajectoryRelease(identity)`
performs a read-only lookup and returns undefined without creating a pin; Store
exposes the equivalent four-argument lookup. The application owns atomic recovery
of any separate facts database and must not silently rebuild missing facts.

## Receipt delivery and settlement triggers

Optional `ExecutionReceipt.eventId` identifies a stable host/environment event.
SQLite schema 3 adds a durable receipt-event ledger. Same event and same canonical
payload are a no-op; same event with different data fails CONFLICT. Event identity
is scoped to a decision. Exact unkeyed duplicate receipts also do not append a new
journal record. `recordReceipt` returns whether it changed receipt state, and the
runtime emits host receipt notifications only on change. Accepted remains unresolved;
only explicit completed/rejected evidence closes an intent. Replaying an earlier
keyed receipt after completion is safe and does not downgrade the terminal status.

`ResearchWorker.feedbackTriggerMode` is `latest_revision` by default, preserving
0.2.1 semantics, or `first_settlement`. First-settlement mode counts a trajectory
once, at its first committed settled event. A persistent indexed ledger is backfilled
from existing feedback journal records during migration. Revised metrics remain
in the research snapshot but never become a new completed trajectory. Trigger
metadata records the selected mode; switching modes does not reset its cursor.

## Scope and verification

No monetary admission gate is added. Usage accounting remains independent from
runtime reliability limits. No npm or remote publishing is performed by this change.
Tests must cover cancellation isolation and late results, separate deadlines,
early pin across activation/restart, persistent receipt dedup/conflict/terminal
ordering, first-settlement revisions, schema migration, package consumption, and
existing regression suites. Back up before migration; all processes sharing the
store must upgrade together. Schema 3 cannot be reopened by 0.2.1.

## Bounded research status reads

Application status polling must not materialize every historical research run.
`listRuns(scopeId?, { limit?, descending? })` pushes the limit and creation-order
sort into SQLite. Defaults preserve ascending creation order and all results.
A scope-only index supports recent bounded status reads without sorting its entire
history; this is creation order, not an updated-at ordering claim.
