# Cloud gateway and tunnel behavior

Status: **2026-09-05: 4 passed, 3 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Start the owned local cloud stack from hosted-web.md and a synthetic Connect
server. Use two disposable accounts where testing isolation. Record gateway,
server and upstream fixture URLs plus request/response metadata with cookies
and authorization redacted. Never use imported production tunnel credentials.

## Source

- `apps/connect/src/worker.ts`
- `apps/connect/src/tunnel-do.ts`
- `apps/connect/src/session.ts`
- `apps/connect/src/servers.ts`
- `apps/connect/src/cache.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Host routing and authentication | Request dashboard, test server subdomain, unknown subdomain and an unauthorized server from two test accounts. | Host selection and authentication route only to the authorized upstream; unknown hosts do not leak server content. |
| HTTP and streaming | Serve known text/binary/compressed responses, errors and a streaming response through the test tunnel. | Status, required headers and bytes are preserved; streaming reaches the client progressively. |
| WebSockets | Open a fixture WebSocket through the tunnel, exchange messages, close and reconnect. | Upgrade and bidirectional traffic work; closure cleans the corresponding tunnel session. |
| Session renewal and revocation | Expire/renew test account or machine sessions, then revoke authorization. | Valid renewal restores access while revoked sessions cannot regain it through cached pages. |
| Document cache | Request cacheable app documents/assets, update the upstream fixture and repeat with another account. | Cache policy/freshness matches source and never serves one account’s authenticated data to another. |
| Tunnel replacement and disconnect | Reconnect only the same synthetic server identity and attempt an unauthorized replacement. | Intended reconnect recovers while wrong credentials cannot claim the tunnel; disconnected response is explicit. |
| Port-share routing | Repeat Connect expose/unexpose through the gateway with independent ports. | Each share routes to the right host/port; removed shares and invalid paths fail without affecting the main app. |

## Evidence and cleanup

Record each row and platform separately with the actual entry point, observed
state, persisted side effect, and evidence. Missing hardware/service access is
a prerequisite gap, not a pass. Stop only owned sessions/processes, restore
preferences, and remove only synthetic resources after evidence is preserved.

## Maintenance notes

- For the progressive-stream check, request `Accept-Encoding: identity` and timestamp each received chunk. Record compressed delivery separately: local Wrangler gzip can coalesce decoded small chunks until stream completion. Source: `apps/connect/src/tunnel-do.ts:304`.
