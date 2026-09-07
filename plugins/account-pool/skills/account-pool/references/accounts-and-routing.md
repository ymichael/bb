The builtin Account Pooler plugin is disabled by default. Enable it, add Claude
or Codex credentials, and inspect its proxy routes and account quota with:

```sh
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
bb pool account add --provider claude --import
bb pool account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
bb pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
bb pool account list [--json]
bb pool account remove <id>
bb pool account enable <id>
bb pool account disable <id>
bb pool account priority <id> <n>
bb pool account reorder <claude|codex> <id>...
bb pool status [--json]
bb pool routing <claude|codex> [--off]
bb pool config
bb pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold> <value>
bb pool token rotate --machine <id-or-name>
bb pool bypass <thread-id> [--off]
```

Claude `--login` starts a PKCE session, prints a browser URL and session ID,
then exits. Pipe the manual callback code to `account login-complete` with that
session ID within ten minutes. Codex `--login` prints a device verification
URL, one-time code, session ID, and an `account login-poll` command that waits
for authorization. The Claude code stays out of process arguments, and either
browser may be on a different machine from the bb server. Newly added or
enabled accounts are available without a plugin reload. With an
enabled account whose secret file remains readable and valid, matching Claude
Code or Codex sessions receive the pool route and a distinct secret token for
their machine.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies them as in-memory app-server config.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`;
`--api-key <key>` is an unsafe compatibility form that exposes the key in
process arguments, shell history, and agent transcripts. Prefer `--import` for
an existing Claude Code login. The CLI Codex import path reads
`~/.codex/auth.json` on the bb server host. OAuth quota refreshes on add or
enable and every five minutes while an account is idle. Account tables add columns for observed
model-family buckets; JSON status exposes their utilization, reset, status,
observation time, and source under `familyWeekly`. Selection skips an account
whose requested family is spent while retaining it for other families. A
present `metadata.user_id` account UUID is aligned with the selected OAuth
account. Use `bb pool config` to inspect the full routing configuration and
`bb pool config set <key> <value>` to update one value. The upstream URL keys
are QA-only overrides; `switchThreshold` must be greater than 0 and at most 1.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 30 idle minutes,
and the pool retains the 4,096 most recently used pins.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.
