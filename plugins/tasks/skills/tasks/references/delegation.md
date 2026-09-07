Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier default|fast|none`:

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--service-tier none` clears a tier.
