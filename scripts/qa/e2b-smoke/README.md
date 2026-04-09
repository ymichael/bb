# E2B Smoke Harness

This smoke validates the real isolated E2B path:

- dedicated local server per run
- dedicated quick tunnel per run
- real sandbox bootstrap and daemon join
- runtime material sync
- suspend and resume
- shared-environment provider turns
- provider auth material for Claude, Codex, and Pi subscription flows

## Auth Fixture

Full subscription coverage uses a local fixture file:

- default path: `/tmp/bb-oauth-handshakes/credentials.json`
- override path: `BB_CLOUD_AUTH_FIXTURE_PATH=/path/to/credentials.json`

The fixture is local operator state. It is not committed to git.

If the fixture is missing, the smoke still runs its non-auth coverage. If you want the smoke to fail unless both Claude and Codex subscription auth are present, set:

- `BB_E2B_SMOKE_REQUIRE_FULL_AUTH=1`

## Acquire Auth

From the repo root, run one helper per provider:

```sh
pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/e2b-smoke/auth-connect.mts --provider claude-code
pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/e2b-smoke/auth-connect.mts --provider codex
```

The helper will:

1. print the real OAuth URL for the current provider
2. listen for the localhost callback
3. write the resulting credential into the local smoke fixture

## When Another Person Is Helping

If another person needs to complete the browser login:

1. run the helper locally
2. send them the printed OAuth URL
3. ask them to return the full final redirect URL from the browser address bar
4. paste that URL back into the waiting terminal when prompted

The helper also accepts pasted callback data directly:

- full redirect URL
- `code=...&state=...`
- `code#state`

So the browser does not need to successfully connect back to localhost as long as the operator can paste the final callback data into the terminal.

## Run The Smoke

From the repo root:

```sh
pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/e2b-smoke.mts
```

For a stricter auth gate:

```sh
BB_E2B_SMOKE_REQUIRE_FULL_AUTH=1 pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/e2b-smoke.mts
```

## Coverage Policy

At startup the smoke prints:

- which fixture path it loaded
- which subscription providers are available
- the exact helper command to acquire any missing auth

That startup report is the canonical operator guide. If you are unsure what the smoke is going to validate, read that report first.
