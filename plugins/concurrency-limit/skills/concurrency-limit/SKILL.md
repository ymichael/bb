---
name: concurrency-limit
description: "Inspect or change global and per-host limits on concurrently running BB threads."
---

# Concurrency limits

Use `bb concurrency-limit status --json` to inspect current limits.

```sh
bb concurrency-limit global [unlimited|<limit>] [--json]
bb concurrency-limit host <host-id> [auto|<limit>] [--json]
```

Automatic host limits allow one thread per available processor. Resolve the host
with `bb machine list` before changing a host limit. Omit the value to inspect it;
change limits only for the requested scope and verify the resulting status.
