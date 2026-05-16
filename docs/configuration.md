# Configuration

The packaged `npx bb-app` flow stores persistent package config under
`~/.bb/config.json`. Use `bb-app config` for values that should apply every
time:

```bash
npx bb-app config OPENAI_API_KEY <key>
npx bb-app config BB_APP_URL http://<machine>.<tailnet>.ts.net:38886
npx bb-app config list
npx bb-app config refresh
```

`bb-app config list` redacts secret values and shows whether they are set.

## Precedence

Configuration is resolved in this order:

1. Explicit launcher flags, such as `--data-dir` or `--server-port`.
2. Persistent `bb-app config` values.
3. Ambient shell environment.
4. Built-in defaults.

For the packaged app, prefer `bb-app config` and launcher flags over shell
variables. The environment remains the internal and deployment substrate, and
source-development commands still load `.env` files.

After `bb-app config` writes `~/.bb/config.json`, it asks the running local
server to reload its config. If bb is not running, the new values apply on the
next start. If you edit `config.json` by hand, run `npx bb-app config refresh`
to apply the file to a running server.

The live reload applies runtime keys such as `OPENAI_API_KEY`, `BB_APP_URL`,
and `BB_INFERENCE_MODEL`. `BB_LOG_LEVEL` applies the next time bb starts.
Feature flags remain source/deployment environment variables rather than
`bb-app config` keys.

When targeting a non-default running instance, pass the same `--data-dir` and
`--server-port` to `bb-app config` commands so they write the right config file
and refresh the right server.

Startup settings such as data directory and ports still apply when the process
starts.

## Common Keys

| Config key           | When to set             | Used for                                                                                                   |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | Recommended             | Generated thread titles, branch names, commit messages, and voice transcription.                           |
| `BB_APP_URL`         | Optional for remote use | Human-facing app URL used for generated links and allowed browser origins. Leave empty for local-only use. |
| `BB_INFERENCE_MODEL` | Optional                | Server-side helper model in `provider/model` format.                                                       |

`OPENAI_API_KEY` is the main key most users should set for the best default
experience. bb's server-side helper model defaults to
`BB_INFERENCE_MODEL=openai/gpt-4o-mini`; without an OpenAI key, those helper
calls return no result. Core threads can still run when the selected provider
CLI is authenticated, such as `codex login` or a logged-in Claude Code install.

## Startup Flags

Use launcher flags for per-run startup details:

```bash
npx bb-app --data-dir ~/.bb-test --server-port 48886 --host-daemon-port 48887
```

The data directory is the root directory for all bb-managed state: the SQLite
database, logs, host identity, and thread storage. It defaults to `~/.bb/` for
the packaged app and `~/.bb-dev/` when using `pnpm dev`. Use `--data-dir` to
point two instances at different data directories for fully isolated
environments.

If the default ports are already in use, set explicit ports before starting:

```bash
npx bb-app --server-port 48886 --host-daemon-port 48887
```

## Source Development

For source development only, `pnpm dev` and `pnpm start` load the repo-root
dotenv cascade. Contributors can start from [`.env.example`](../.env.example)
for a local development template:

```bash
cp .env.example .env
```

The standard [dotenv-cli](https://github.com/entropitor/dotenv-cli) cascade
applies to source development. `pnpm dev` loads `.env`, `.env.local`,
`.env.development`, and `.env.development.local`; `pnpm start` loads `.env`,
`.env.local`, `.env.production`, and `.env.production.local`.

Source checkout commands such as `pnpm bb`, `pnpm bb:dev`, and `pnpm reset`
are thin wrappers around `@bb/scripts`. Those wrappers force `NODE_ENV` to the
intended mode so ambient shell state does not silently retarget bb.

Use `pnpm reset` or `pnpm reset:dev` to clear a data directory. These only
remove bb-managed state, not provider credentials.
