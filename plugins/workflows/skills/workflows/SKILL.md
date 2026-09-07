---
name: workflows
description: "Author or run durable BB workflows when the user requests workflow execution or multi-agent orchestration."
---

# BB workflows

Use a workflow when the user explicitly asks for multi-agent orchestration.
Ordinary tasks do not authorize a workflow run.

A workflow puts deterministic control flow around normal BB worker threads. The
script can fan out work, pipeline stages, verify results, and return structured
data. Worker threads retain normal workspace tools and permissions.

## Start safely

1. Inspect the task and repository before you choose the work list.
2. Confirm the provider, model, and reasoning tuple from the live catalog.
3. Write the smallest workflow that gives the requested coverage.
4. Validate the exact source before execution.
5. Start the background run.
6. Emit the returned workflow preview directive exactly once.
7. Use compact status for progress and paged history for details.

Check an explicit model selection with:

```sh
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Do not guess model identifiers or partial selection tuples.

## Read only the required detail

- Read references/authoring.md when you write or change workflow source,
  schemas, agent options, or nested workflows.
- Read references/orchestration.md when you design pipelines, barriers,
  verification, panels, loops, or other quality controls.
- Read references/runs.md when you validate, start, inspect, stop, or resume a
  workflow.

## Minimal source

Every script starts with a literal meta object:

```js
export const meta = {
  name: "review-change",
  description: "Review a change and verify the findings",
  phases: [{ title: "Review" }, { title: "Verify" }],
};
const results = await pipeline(
  args.items,
  (item) => agent("Review " + item, { phase: "Review" }),
  (review, item) =>
    agent("Verify this review for " + item + ":\n" + review, {
      phase: "Verify",
    }),
);
return results;
```

Workflow source is JavaScript, not TypeScript. The script has no filesystem,
shell, network, import, clock, or random access. Worker agents can use their
normal tools.

Use pipeline for independent multi-stage items. Use a parallel barrier only
when the next stage needs all prior results.

Use an agent schema when later stages need reliable structured data. A
structured worker must return its value through the workflow result tool.

## Execute

Validate and run with the same source selector:

```sh
bb workflows validate --file .bb/workflows/review-change.js
bb workflows run --file .bb/workflows/review-change.js --args '{"items":[]}'
```

The agent tool accepts script, scriptPath, or name. The CLI accepts --script,
--file, or --name.

After a successful agent-tool call, copy its previewDirective into the
assistant response as one standalone line. Do not edit or repeat it.

Use bb workflows status for compact progress. Redirect bounded history pages
into BB_THREAD_STORAGE before inspection because history can contain full
prompts and results.

## Quality check

- The user explicitly requested workflow orchestration.
- The source passes bb workflows validate.
- Every explicit provider tuple exists in the live catalog.
- Each phase name matches its meta entry.
- Independent items use pipeline without an unnecessary barrier.
- Bounded coverage logs what it omits.
- Structured consumers receive schema-validated results.
- The final response uses status or inspected history, not assumptions.
