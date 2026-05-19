---
kind: instruction
title: bb Guide - Status
summary: How STATUS.html works and how to call back to the manager from it.
intent: Teach agents how to author interactive STATUS.html that talks to its manager thread.
editingNotes: Keep this as the canonical authoring reference for STATUS.html behaviour. Manager prompts should link here rather than duplicating bridge guidance.
---
STATUS.html — interactive manager-thread surface

`STATUS.html` lives in the manager thread's storage and renders inside the bb
secondary panel as an unsandboxed iframe (script-enabled, full network access).
The manager owns the file: it reads it before deciding what to do, and edits
it directly to update what the user sees. Only one STATUS.html per manager
thread.

Authoring basics:

- Put it at the manager thread's storage root, named exactly `STATUS.html`.
- Use Tailwind plus bb's CSS tokens (`bb guide styling`) for visual style.
- Keep it dense and minimal — the panel is narrow.
- Re-render the whole file when state changes; the iframe reloads on edit.

Talking back to the manager — `window.bbStatus.tell(text)`

The bb app injects no API into the iframe at load. Instead, the bundled default
STATUS.html ships a small helper that posts a message to the parent window.
The parent forwards the text as a new **user turn** in the manager thread.
That user turn appears in the thread timeline like any other; the manager
decides exactly how to react (often by editing STATUS.html, appending to a
todo list, or spawning a worker).

```html
<script>
  await window.bbStatus.tell("Mark todo #3 as done");
</script>
```

`tell(text)` returns a `Promise<void>`. It resolves when the bb app has
accepted the message and queued it as a user turn; it rejects with the bridge
error (e.g. oversize) when validation fails. It does **not** wait for the
manager's response — that arrives asynchronously, usually as a new STATUS.html
edit.

Common patterns:

```html
<!-- Button -> tell -->
<button id="cancel-42" type="button">Cancel #42</button>
<script>
  document.getElementById("cancel-42").addEventListener("click", async () => {
    await window.bbStatus.tell("Cancel PR #42");
  });
</script>
```

```html
<!-- Checkbox -> tell -->
<input id="todo-7" type="checkbox" />
<label for="todo-7">Investigate flaky test</label>
<script>
  document.getElementById("todo-7").addEventListener("change", async (event) => {
    if (event.target.checked) {
      await window.bbStatus.tell("Mark todo #7 (investigate flaky test) as done");
    }
  });
</script>
```

```html
<!-- Form submit -> tell -->
<form id="note">
  <input name="text" placeholder="note for the manager" />
  <button type="submit">Send</button>
</form>
<script>
  document.getElementById("note").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = event.target.elements.text.value.trim();
    if (text.length === 0) return;
    await window.bbStatus.tell(`User note: ${text}`);
    event.target.reset();
  });
</script>
```

Authoring the message text

The text you send becomes a literal user turn in the manager thread. The
manager reads STATUS.html before acting on it, so phrase the message so the
manager has enough context to act without ambiguity. Refer to items by the
same label, id, or PR number used in STATUS.html so the manager can find them.

Good:

- `"Mark todo #3 (write release notes) as done"`
- `"Cancel worker thr_abc123 — the user changed their mind"`
- `"Promote PR #42 to ready-for-review"`

Avoid:

- `"done"` (which one?)
- `"cancel that"` (which?)

Limits and behaviour

- Message size: 4 KiB. Larger payloads are rejected at the bridge with an
  error; the promise rejects rather than silently truncating.
- Only the bb app frontend listens. STATUS.html opened in a regular browser
  tab will see `tell()` post to an empty parent and never resolve.
- The bridge does not write files, run tools, or expose state. It only
  forwards text to the manager thread as a user turn.
- The bb app scopes replies by iframe contentWindow identity, not origin, so
  the reply ack lands only on the iframe that issued the call.

Where the helper is defined

The bundled default STATUS.html (the manager template) inlines the helper
before `</body>`. If you re-author STATUS.html from scratch, copy the snippet
from the snippet-library comment block in the default template, or inline a
minimal version:

```html
<script>
  window.bbStatus = (() => {
    let nextId = 1;
    const pending = new Map();
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      if (!event.data || event.data.type !== "bb-status:tell-result") return;
      const handler = pending.get(event.data.id);
      if (!handler) return;
      pending.delete(event.data.id);
      event.data.ok
        ? handler.resolve()
        : handler.reject(new Error(event.data.error || "bb-status:tell failed"));
    });
    return {
      tell(text) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          window.parent.postMessage({ id, type: "bb-status:tell", text }, "*");
        });
      },
    };
  })();
</script>
```
