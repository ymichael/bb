# Code Review Checklist

This document defines the dimensions of a thorough code review. Each section is designed to be evaluated independently — reviewers may delegate sections to separate agents working in parallel.

## Unbiased Review Protocol

A code review must be unbiased. Do not prime the reviewer with known issues, hints, or narrowed scope. Specifically:

- **Full branch scope.** Review all commits on the branch, not just the latest. A bug introduced in commit 2 and masked by a workaround in commit 9 is still a design problem — the workaround should be removed and the root cause fixed.
- **Use the correct merge base.** Don't naively diff the branch against the current tip of main — main may have moved since the branch was created. Use `git merge-base main <branch>` to find the actual fork point, then diff against that. Otherwise you'll review unrelated changes that landed on main after the branch diverged, or miss context about what the branch was built on top of.
- **No leading the witness.** Do not tell the reviewer what bugs were previously found or where to look. Let them discover issues independently.
- **Separate verification from discovery.** If you need to confirm a specific fix *and* do a general review, use two agents: one scoped to verify the fix, one with zero prior context doing a fresh review. Mixing the two biases the reviewer toward the known issue and away from finding new ones.

---

## 1. Plan Adherence

If the work is driven by a plan (in `plans/`), verify. If there is no plan, skip this section.

- Does the implementation match the plan's scope and approach?
- Are there deviations? If so, are they justified or accidental drift?
- Are the plan's exit criteria met?

## 2. Correctness

- Does the code do what it claims to do?
- Trace edge cases: nulls, empty collections, concurrent access, error paths.
- Follow untrusted input from entry point through every mutation — don't just confirm the happy path.
- Check boundary conditions in queries, loops, and conditionals.

## 3. Maintainability

- Will this code be easy to modify when requirements change?
- Is the foundation solid, or are we building on something brittle that will cost us later?
- Are responsibilities clearly separated, or is logic entangled across concerns?
- Would a new contributor understand *why* this code exists, not just *what* it does?
- Is complexity abstracted into well-named, well-scoped functions that can be understood and tested independently?
- Are files a reasonable size, or is there a thousand-line module that no one will want to touch?
- Are names precise? A function called `process` or `handle` is a smell — what does it *actually* do?

## 4. Shortcuts and Workarounds

This is its own section because shortcuts are the single most common source of accumulated debt. Every shortcut that lands becomes the foundation for the next feature.

- Is any part of this change working around an architectural limitation?
- Would this complexity disappear if we changed the protocol, schema, or data model instead?
- If a workaround is genuinely necessary, is it explicitly marked and scoped, or is it hiding as normal code?
- Watch for: type casts, string manipulation of structured data, defensive parsing of typed values, compatibility shims for problems that should be fixed upstream.

## 5. Security

- Are authorization checks enforced at the right layer? Don't rely on the UI to gate access — verify server-side.
- Is user input validated and sanitized at system boundaries before it reaches queries, commands, or templates?
- Are secrets, tokens, or credentials kept out of logs, error messages, and client-facing responses?
- Check for OWASP top 10: injection, broken auth, sensitive data exposure, mass assignment.

## 6. Performance

- Are there N+1 query patterns? Unbounded result sets missing pagination or limits?
- Is work being done in JS that the database could do with a targeted query?
- On the UI side: unnecessary re-renders, missing memoization on expensive computations, large bundles loaded eagerly when they could be lazy?
- Does the change scale with data growth, or does it assume small inputs?

## 7. AGENTS.md Compliance

Verify the change does not violate any guideline in `AGENTS.md`. Pay particular attention to type safety, mocking discipline, and database query patterns.

## 8. Test Quality

- **Coverage:** Are the important branches tested? Not line count — are the meaningful decision points covered?
- **Behavior over implementation:** Tests should assert on outcomes (state, return values, persisted data), not call sequences or internal structure.
- **Mocking discipline:** Only mock at true external boundaries (network, timers). Never mock the database — use in-memory SQLite. Never mock the module under test.
- **Failure value:** Could this test catch a real bug? A test that passes when the code is broken is worse than no test.

## 9. Readability and Cognitive Load

- Can you hold the entire change in your head and form a clear mental model?
- Is the code structured so that *reading order* matches *execution order* where possible?
- Is there a clear narrative to the change, or do you have to jump between files to understand what's happening?
