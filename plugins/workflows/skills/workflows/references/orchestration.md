# Workflow orchestration patterns

## Pipeline by default

DEFAULT TO `pipeline()`. Only reach for a barrier (`parallel` between stages)
when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of
stage N-1:

- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification
  entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:

- "I need to flatten/map/filter first" — do it inside a pipeline stage:
  `pipeline(items, stageA, r => transform([r]).flat(), stageB)`
- "The stages are conceptually separate" — that's what `pipeline()` models.
  Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the
  slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle
  time.

Smell test: if you wrote

```js
const a = await parallel(/* ... */);
const b = transform(a); // flatten, map, filter — no cross-item dependency
const c = await parallel(/* b.map(...) */);
```

that middle transform doesn't need the barrier. Rewrite as a pipeline with the
transform inside a stage. When in doubt: pipeline.

The canonical multi-stage pattern — pipeline by default, each dimension
verifies as soon as its review completes:

```js
export const meta = {
  name: "review-changes",
  description: "Review changed files across dimensions, verify each finding",
  phases: [{ title: "Review" }, { title: "Verify" }],
};
const dimensions = [
  { key: "bugs", prompt: "Review for correctness bugs" },
  { key: "perf", prompt: "Review for performance problems" },
];
const results = await pipeline(
  dimensions,
  (dimension) =>
    agent(dimension.prompt, {
      label: `review:${dimension.key}`,
      phase: "Review",
      schema: {
        type: "object",
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["title", "file"],
              properties: {
                title: { type: "string" },
                file: { type: "string" },
              },
            },
          },
        },
      },
    }),
  (review) =>
    parallel(
      review.findings.map(
        (finding) => () =>
          agent(`Adversarially verify: ${finding.title}`, {
            label: `verify:${finding.file}`,
            phase: "Verify",
            schema: {
              type: "object",
              required: ["isReal"],
              properties: { isReal: { type: "boolean" } },
            },
          }).then((verdict) => ({ ...finding, verdict })),
      ),
    ),
);
return results
  .flat()
  .filter(Boolean)
  .filter((finding) => finding.verdict?.isReal);
```

When a barrier IS correct — dedup across all findings before expensive
verification:

```js
const all = await parallel(
  dimensions.map(
    (dimension) => () =>
      agent(dimension.prompt, {
        schema: {
          type: "object",
          required: ["findings"],
          properties: {
            findings: { type: "array", items: { type: "object" } },
          },
        },
      }),
  ),
);
const deduped = dedupeByFileAndLine(
  all.filter(Boolean).flatMap((result) => result.findings),
); // genuinely needs ALL at once
const verified = await parallel(
  deduped.map(
    (finding) => () =>
      agent(verifyPrompt(finding), {
        schema: {
          type: "object",
          required: ["isReal"],
          properties: { isReal: { type: "boolean" } },
        },
      }),
  ),
);
```

## Quality patterns

These are common shapes; pick by task and compose freely:

- **Adversarial verify:** spawn N independent skeptics per finding, each
  prompted to REFUTE. Kill if at least a majority refute. This prevents
  plausible-but-wrong findings from surviving.
- **Perspective-diverse verify:** when a finding can fail in more than one way,
  give each verifier a distinct lens (correctness, security, performance,
  does-it-reproduce) instead of N identical refuters — diversity catches
  failure modes redundancy can't.
- **Judge panel:** generate N independent attempts from different angles (for
  example, MVP-first, risk-first, user-first), score with parallel judges, and
  synthesize from the winner while grafting the best ideas from runners-up.
- **Loop-until-dry:** for unknown-size discovery (bugs, issues, edge cases),
  keep spawning finders until K consecutive rounds return nothing new. Simple
  counters (`while count < N`) miss the tail.
- **Multi-modal sweep:** parallel agents each search a different way
  (by-container, by-content, by-entity, by-time). Each is blind to what the
  others surface; use this when one search angle won't find everything.
- **Completeness critic:** a final agent asks "what's missing — modality not
  run, claim unverified, source unread?" What it finds becomes the next round of
  work.
- **No silent caps:** if a workflow bounds coverage (top-N, no-retry,
  sampling), `log()` what was dropped — silent truncation reads as "covered
  everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote
verify. "thoroughly audit this" or "be comprehensive" → larger finder pool,
3–5 vote adversarial pass, synthesis stage. When unsure, lean toward
thoroughness for research/review/audit requests and toward brevity for quick
checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls
for it (tournament brackets, self-repair loops, staged escalation, whatever
fits).

Use workflows for multi-step orchestration where control flow should be
deterministic (loops, conditionals, fan-out) rather than model-driven.
