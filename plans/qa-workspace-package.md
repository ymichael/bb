# QA Workspace Package

## Goal

Move executable QA infrastructure out of `scripts/qa` and into a first-class workspace package so it participates in dependency ownership, typechecking, and Turbo task orchestration.

The desired end state is:

- Manual QA documentation remains under `qa/`.
- Executable QA tooling lives under `tests/qa` as `@bb/qa`.
- QA commands run through Turbo with explicit package dependencies.
- No script needs to borrow another package's dependency context with commands like `pnpm --filter @bb/sandbox-host exec tsx ../../scripts/qa/...`.

## Motivation

The current `scripts/qa` tree contains real application-adjacent tooling, not loose one-off scripts:

- `scripts/qa/e2b-smoke.mts` imports database, server, contract, sandbox, auth, and domain internals.
- `scripts/qa/e2b-smoke/fixture.ts` owns typed fixture contracts and validation.
- `scripts/qa/shared.mjs` owns reusable server, process, port, tunnel, and test-repo orchestration helpers.
- The E2B smoke README runs TypeScript files through `@bb/sandbox-host` only to access that package's `tsx` dependency.

That shape is brittle because the code has no package-local dependency declarations, no package-local TypeScript boundary, and no direct Turbo integration. Changes in unrelated packages can break the scripts without the normal `build`, `typecheck`, or `test` paths catching it.

## Scope

In scope:

- Create `tests/qa` as workspace package `@bb/qa`.
- Move executable QA files from `scripts/qa` into `tests/qa/src`.
- Convert `.mjs` QA helpers and commands to TypeScript.
- Add `@bb/qa` scripts for typechecking, E2B smoke testing, auth fixture setup, and standalone lifecycle commands.
- Add or adjust Turbo task definitions for QA commands.
- Update README and inline command references to use `@bb/qa`.
- Delete `scripts/qa` after all references are migrated.

Out of scope:

- Rewriting the E2B smoke flow semantics.
- Moving manual runbooks out of top-level `qa/`.
- Generalizing QA orchestration into reusable product runtime libraries.
- Making E2B smoke part of the default test suite unless a separate decision is made.

## Target Layout

```text
qa/
  manual-manager-runbook.md
  manual-pass-log.md
  manual-runbook.md

tests/qa/
  package.json
  tsconfig.json
  src/
    e2b-smoke.ts
    e2b-smoke/
      README.md
      auth-connect.ts
      fixture.ts
    standalone/
      cleanup.ts
      start.ts
      stop.ts
    shared/
      dotenv.ts
      git.ts
      ports.ts
      process.ts
      server.ts
      tunnel.ts
```

The exact `shared/` split can be adjusted during implementation. The important boundary is that executable QA code is owned by `@bb/qa`, while human QA notes remain under top-level `qa/`.

## Package Design

Create `tests/qa/package.json`:

```json
{
  "name": "@bb/qa",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "clean": "rimraf dist tsconfig.tsbuildinfo",
    "typecheck": "tsc --noEmit",
    "test:e2b-smoke": "tsx src/e2b-smoke.ts",
    "auth:e2b-smoke": "tsx src/e2b-smoke/auth-connect.ts",
    "standalone:start": "tsx src/standalone/start.ts",
    "standalone:stop": "tsx src/standalone/stop.ts",
    "standalone:cleanup": "tsx src/standalone/cleanup.ts"
  },
  "dependencies": {
    "@bb/agent-provider-auth": "workspace:*",
    "@bb/agent-providers": "workspace:*",
    "@bb/db": "workspace:*",
    "@bb/domain": "workspace:*",
    "@bb/host-daemon-contract": "workspace:*",
    "@bb/host-runtime-material": "workspace:*",
    "@bb/sandbox-host": "workspace:*",
    "@bb/sandbox-image": "workspace:*",
    "@bb/server": "workspace:*",
    "@bb/server-contract": "workspace:*"
  },
  "devDependencies": {
    "@bb/tsconfig": "workspace:*",
    "@types/node": "^22.0.0",
    "rimraf": "^6.1.0",
    "tsx": "^4.21.0",
    "typescript": "^5.7.0"
  }
}
```

Adjust this list during implementation based on actual imports. Do not keep hidden dependency coupling through another package's `exec` context.

Create `tests/qa/tsconfig.json` extending `@bb/tsconfig/base.json`. Because the current smoke scripts import some source files that may not be exported package surfaces yet, start with a test-style config similar to `tests/integration/tsconfig.json`:

```json
{
  "extends": "@bb/tsconfig/base.json",
  "compilerOptions": {
    "baseUrl": "../..",
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "outDir": "dist",
    "rootDir": "../..",
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["./src/**/*.ts"]
}
```

Prefer package exports where they already exist. If a needed server or package module is not exported and is only used for QA orchestration, keep the direct source import for this migration rather than expanding public API surface prematurely.

## Turbo Integration

Add Turbo tasks for package-owned QA commands:

```json
{
  "test:e2b-smoke": {
    "dependsOn": ["build", "^build"],
    "cache": false,
    "passThroughEnv": [
      "BB_E2B_SMOKE_REQUIRE_FULL_AUTH",
      "BB_QA_AUTH_FIXTURE_PATH",
      "E2B_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY"
    ]
  }
}
```

Only include environment variables actually used by the migrated scripts. If the smoke test relies on additional variables, add them explicitly rather than using `passThroughEnv: ["*"]`.

The root `package.json` can optionally expose convenience commands:

```json
{
  "scripts": {
    "qa:e2b-smoke": "pnpm exec turbo run test:e2b-smoke --filter=@bb/qa",
    "qa:e2b-auth": "pnpm exec turbo run auth:e2b-smoke --filter=@bb/qa"
  }
}
```

If `auth:e2b-smoke` should run through Turbo, add a matching uncached Turbo task. If it remains an interactive credential helper, it can stay as a package script invoked with `pnpm --filter @bb/qa auth:e2b-smoke`.

## Migration Steps

1. Create `tests/qa` package.

   Add `package.json` and `tsconfig.json`. Confirm `pnpm-workspace.yaml` already includes `tests/*`, so no workspace glob change should be needed.

2. Move E2B smoke files.

   Move:

   - `scripts/qa/e2b-smoke.mts` to `tests/qa/src/e2b-smoke.ts`
   - `scripts/qa/e2b-smoke/auth-connect.mts` to `tests/qa/src/e2b-smoke/auth-connect.ts`
   - `scripts/qa/e2b-smoke/fixture.ts` to `tests/qa/src/e2b-smoke/fixture.ts`
   - `scripts/qa/e2b-smoke/README.md` to `tests/qa/src/e2b-smoke/README.md`

   Update relative imports to package imports where the imported package has a stable export. Keep source imports only when no package export exists.

3. Convert shared helpers to TypeScript.

   Move `scripts/qa/shared.mjs` into `tests/qa/src/shared` or `tests/qa/src/shared.ts`. Add explicit types for exported functions and replace loose `unknown`-style parsing with local validation helpers or package schemas.

4. Move standalone lifecycle commands.

   Move:

   - `scripts/qa/start-standalone.mjs` to `tests/qa/src/standalone/start.ts`
   - `scripts/qa/stop-standalone.mjs` to `tests/qa/src/standalone/stop.ts`
   - `scripts/qa/cleanup-standalone.mjs` to `tests/qa/src/standalone/cleanup.ts`

   Update help text to use `pnpm --filter @bb/qa standalone:*` commands.

5. Update command references.

   Search project-wide for `scripts/qa`, `e2b-smoke.mts`, `auth-connect.mts`, `start-standalone.mjs`, `stop-standalone.mjs`, and `cleanup-standalone.mjs`. Update every README, fixture command string, and help message.

6. Add Turbo task configuration.

   Add `test:e2b-smoke` to `turbo.json`. Add any additional QA tasks only if they are non-interactive and useful through Turbo.

7. Remove the old script directory.

   Delete `scripts/qa` once all references are migrated and validation passes.

## Validation

Run these commands during the migration:

```sh
pnpm install --lockfile-only
pnpm exec turbo run typecheck --filter=@bb/qa
pnpm exec turbo run build --filter=@bb/qa
pnpm exec turbo run test:e2b-smoke --filter=@bb/qa --dry=json
rg -n "scripts/qa|e2b-smoke\\.mts|auth-connect\\.mts|start-standalone\\.mjs|stop-standalone\\.mjs|cleanup-standalone\\.mjs" .
```

If credentials and E2B access are available, also run:

```sh
pnpm exec turbo run test:e2b-smoke --filter=@bb/qa --force > /tmp/bb-e2b-smoke.txt 2>&1
```

Then inspect `/tmp/bb-e2b-smoke.txt`.

For interactive auth fixture setup, verify the command starts and prints help:

```sh
pnpm --filter @bb/qa auth:e2b-smoke -- --help
```

## Exit Criteria

- `@bb/qa` exists under `tests/qa` and is discovered by pnpm.
- All executable QA code previously under `scripts/qa` has moved into `@bb/qa`.
- All moved files are TypeScript and pass `pnpm exec turbo run typecheck --filter=@bb/qa`.
- E2B smoke can be invoked with `pnpm exec turbo run test:e2b-smoke --filter=@bb/qa`.
- No project references remain to `scripts/qa`.
- Manual QA runbooks remain under top-level `qa/`.
- `scripts/qa` is deleted.

## Open Decisions

- Whether root-level convenience scripts like `qa:e2b-smoke` are worth adding, or whether all callers should use the Turbo command directly.
- Whether standalone lifecycle commands should live in `@bb/qa` permanently or move later to `@bb/scripts` if they become general developer tooling.
- Whether any currently internal server modules used by the smoke test deserve explicit test-support exports.
