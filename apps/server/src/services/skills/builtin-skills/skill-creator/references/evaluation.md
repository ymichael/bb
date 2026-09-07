## Evaluation

Create two or three realistic prompts. State the expected result for each
prompt. Include near-miss prompts when you tune the description.

Spawn a fresh thread for every test:

```sh
bb thread spawn --project "$BB_PROJECT_ID" --prompt "<test prompt>" --json
bb thread wait <thread-id>
bb thread output <thread-id>
bb thread log <thread-id>
bb thread show <thread-id> --git-diff
```

Read the transcript, not only the final answer. Check whether the skill
triggered, whether the agent read only relevant resources, and whether the
instructions improved the result.

For an existing skill, compare the revision with the previous version. For a
new skill, compare it with a run that does not expose the skill. Use an
objective check when the result has a machine-verifiable contract.
