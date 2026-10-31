# Webhook platform coverage

Every interaction the generic `webhook` platform has with Hypotenuse, the module that handles it, and the test that
proves it (AGENTS.md rule 10). `backend/__tests__/docs/coverage.test.ts` asserts each row's test file exists and
mentions the row's id. The wire format is documented in `backend/platforms/webhook/adapter.ts` and, for operators, in
the user docs' *Webhook platform* page.

| Id | Interaction | Module | Test |
|---|---|---|---|
| `webhook.in.signature` | every inbound delivery is verified over its raw bytes; any routing or signature failure is one byte-identical 404 | `backend/ops/IngressOps.ts` | `backend/__tests__/channels/ingress.test.ts` |
| `webhook.in.dedupe` | a retried delivery is one event; two events carrying one message are one inbox row | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/ingress.test.ts` |
| `webhook.in.message` | `type: message` — a person's message, addressed by `mentions` or a DM | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/processing.test.ts` |
| `webhook.in.interaction.answer` | `type: interaction`, `kind: answer` — an option button answering a question | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/processing.test.ts` |
| `webhook.in.interaction.approval` | `type: interaction`, `kind: approval` (or a reply `approve <id>`) — an in-channel approval decision under the binding's policy | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/conformance.ts` |
| `webhook.in.signal` | `type: signal` — `stop` / `disengage` cancel the conversation | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/processing.test.ts` |
| `webhook.in.lifecycle` | `type: lifecycle` — `uninstall` marks the installation, `channel_archived` the channel | `backend/ops/TriggerEventOps.ts` | `backend/__tests__/channels/processing.test.ts` |
| `webhook.out.ping` | `bot-installation:test`'s signed probe, answered with `{botUserId}` | `backend/platforms/webhook/adapter.ts` | `backend/__tests__/channels/harness.ts` |
| `webhook.out.surface` | the signed delivery of each surface kind — `status`, `stream`, `plan`, `message`, `question`, `approval` — with `Hypotenuse-Delivery` | `backend/platforms/webhook/adapter.ts` | `backend/__tests__/channels/conformance.ts` |
| `webhook.out.retry` | 2xx sent (with `messageId`), 408/429 (`Retry-After`)/5xx retried, other 4xx undeliverable, a lost response retried with the same delivery id | `backend/ops/OutboxOps.ts` | `backend/__tests__/channels/outbox.test.ts` |
