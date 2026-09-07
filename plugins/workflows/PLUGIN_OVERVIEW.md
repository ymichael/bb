Run a script that fans work out to many agent threads, pipelines their results, and returns structured data. The run survives restarts and continues from the last completed step.

## What you get

- A live run card in chat that shows the state, phases, active workers, and elapsed time.
- A status card above the composer for each active run in the thread, with a stop control.
- A **Workflow run** panel that lists every phase and worker call and links each worker to its thread.
- A completion message delivered to the thread that started the run.
- Settings for active runs, agent concurrency, call budget, run timeout, retention days, and notification size.

## How it works

A workflow is a JavaScript file. It runs in a sandbox with no file, shell, network, or clock access. Calls to `agent(...)` start normal bb worker threads with their usual tools and permissions. Scripts can pipeline stages, run parallel barriers, and request a JSON Schema for a worker's output. Successful calls are cached, so a resumed or restarted run replays them and continues live from the first change.

Worker threads stay hidden from the sidebar. Expired runs are archived after the retention period.

## For agents

Agents start runs with the `bb_workflow_run` tool and inspect them with the `bb workflows` CLI: `validate`, `run`, `status`, `history`, `list`, and `stop`. Scripts come from an inline `--script`, a `--file`, or a `--name` under `.bb/workflows/`. Structured workers return results with `bb_workflow_result`. The bundled `workflows` skill covers authoring, validation, and safe inspection.

## Requirements

The plugin is off by default. Commands must run inside a bb project thread.
