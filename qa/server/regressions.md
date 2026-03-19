# Server Regression QA

Use this doc to capture stable repros for previously discovered server-owned bugs.

## Goal

Make sure once a server-owned lifecycle or control-plane bug is fixed, it stays fixed.

## Add regressions here when the bug is primarily about

- persisted thread state convergence
- restart or resume visibility from the server's point of view
- control-plane actions such as stop, archive, unarchive, promote, and demote
- operator-facing state becoming ambiguous even when runtime behavior is otherwise healthy

## Seed areas

- restart while active leaving thread state ambiguous instead of converging cleanly
- follow-up after restart failure not clearing `error` back to a healthy terminal state
- control-plane actions leaving contradictory thread state behind
- provisioning-boundary restart incorrectly landing in a healthy terminal state without a real turn

## Template

### `<regression name>`

- **Source:** `<issue / PR / incident>`
- **Setup:** `<minimal environment assumptions>`
- **Steps:**
  1. ...
  2. ...
  3. ...
- **Expected:**
  - ...
  - ...
- **Protected invariants:**
  - ...
  - ...
