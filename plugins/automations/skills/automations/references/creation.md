Schedule flags:

```text
--cron <expr>                  Recurring 5-field cron expression
--timezone <tz>                IANA timezone for --cron
--at <datetime>                One-shot run time, preferably ISO 8601
--in <duration>                One-shot delay, e.g. 30s, 5m, 2h, 1d
```

Agent mode flags:

```text
--prompt <prompt>              Prompt to run when due
--provider <id>                Provider ID
--model <model>                Model ID
--reasoning <level>            none, low, medium, high, xhigh, ultracode, max, or ultra
--service-tier <tier>          default or fast (update also accepts none to clear)
--permission-mode <mode>       accept-edits, auto, or full
--target-thread <id>           Reuse/re-prompt an existing thread
--environment <id-or-path>     Existing environment ID or unmanaged workspace path
--new-environment <kind>       Create a new environment (worktree)
--base-branch <branch>         Base branch for new managed worktrees
```

When `--permission-mode` is omitted, the plugin chooses Approve for me
(`auto`) when the provider supports it and otherwise uses Full Access
(`full`).

Script mode flags:

```text
--script <inline>              Inline script content
--script-file <path>           Copy script content from a file on a host
--host <name-or-id>            Host that owns --script-file (default: thread host or server)
--interpreter <name>           bash, sh, node, or python3
--timeout <ms>                 Timeout in milliseconds, default 120000, max 900000
--env-json <json>              Script variables as a string-to-string JSON object
```
