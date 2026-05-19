---
kind: instruction
title: bb Guide - Status Data
summary: STATUS_DATA.json read/write API for interactive STATUS.html documents.
intent: Teach agents how to persist arbitrary JSON state next to STATUS.html and how STATUS.html can read/write it from the iframe at runtime.
editingNotes: Keep this as the canonical reference for the STATUS_DATA.json contract. STATUS.html-side examples should use the `window.bbStatus` API.
---
STATUS_DATA.json

`STATUS_DATA.json` is a free-form JSON file stored next to `STATUS.html` in
the manager thread's storage directory
(`~/.bb/thread-storage/<thread-id>/STATUS_DATA.json`). Use it to back any
state that an interactive `STATUS.html` needs to persist across reloads —
todo lists, in-flight worker rosters, open PR snapshots, dismissed
notifications, anything.

There is no schema. Whatever shape your `STATUS.html` understands is fine.
Suggested top-level keys are `openPrs`, `activeWorkers`, `todos`, but those
are conventions, not contracts.

## Limits and semantics

- Maximum payload: **1 MiB**. Anything larger is rejected with 413.
- The path is constrained to a **bare filename** — no slashes, no `..`, no
  leading dot. The default name is `STATUS_DATA.json`; if you want
  per-feature sidecars, pick a name like `STATUS_TODOS.json`.
- The route is **whole-file overwrite**. There is no merge, no patch, no
  locking. Every writer must read, modify, and write the full document.
  Concurrent writers will clobber each other — design accordingly (single
  writer, debounce, or merge in the writer).

## STATUS.html — `window.bbStatus`

When `STATUS.html` is rendered in the bb secondary panel, the app shell
exposes a small `window.bbStatus` global. It postMessages to the bb parent
window, which proxies to the server.

```js
// Both calls return Promises. `read` resolves to `null` when the file does
// not exist yet so the page can render an empty initial state without a
// try/catch. Whole-file overwrite — no merging, no locking.
const data = (await window.bbStatus.read()) ?? { todos: [] };
data.todos.push({ id: crypto.randomUUID(), text: "ship it", done: false });
await window.bbStatus.write(data);
```

Both helpers take an optional `path` argument when you want a sibling file:

```js
const tasks = await window.bbStatus.read("STATUS_TASKS.json");
await window.bbStatus.write({ counter: 1 }, "STATUS_COUNTER.json");
```

A worked example — minimal interactive todo list:

```html
<form id="add-todo">
  <input name="text" placeholder="What needs doing?" required />
  <button type="submit">Add</button>
</form>
<ul id="todos"></ul>

<script>
  async function render() {
    const data = (await window.bbStatus.read()) ?? { todos: [] };
    const list = document.getElementById("todos");
    list.innerHTML = "";
    for (const todo of data.todos) {
      const li = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = todo.done;
      checkbox.addEventListener("change", async () => {
        const current = (await window.bbStatus.read()) ?? { todos: [] };
        const target = current.todos.find((t) => t.id === todo.id);
        if (target) target.done = checkbox.checked;
        await window.bbStatus.write(current);
        await render();
      });
      const label = document.createElement("span");
      label.textContent = todo.text;
      li.append(checkbox, label);
      list.append(li);
    }
  }

  document.getElementById("add-todo").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const text = form.text.value.trim();
    if (!text) return;
    const current = (await window.bbStatus.read()) ?? { todos: [] };
    current.todos.push({ id: crypto.randomUUID(), text, done: false });
    await window.bbStatus.write(current);
    form.reset();
    await render();
  });

  render();
</script>
```

## External tools and the manager thread

Other tools — the manager thread itself, scripts you write, an automation —
can also read and write `STATUS_DATA.json`. Two ways:

- Direct filesystem: `~/.bb/thread-storage/<thread-id>/STATUS_DATA.json`.
  Cheapest from inside the host.
- HTTP API on the bb server:

  ```
  GET  /api/v1/threads/:threadId/thread-storage/content?path=STATUS_DATA.json
  PUT  /api/v1/threads/:threadId/thread-storage/content?path=STATUS_DATA.json
       Content-Type: application/json
       <body is the new file contents>
  ```

  The PUT route accepts `application/json` or `text/plain`, validates the
  path is a bare filename, and rejects payloads larger than 1 MiB with 413.
  On success it returns `{ ok: true, path, sizeBytes }`. The GET route
  returns the file's bytes with their stored `Content-Type`, or 404 if the
  file does not exist yet.

## Picking a name

Use `STATUS_DATA.json` for the document your `STATUS.html` reads on every
render. Pick a `STATUS_<FEATURE>.json` sibling when a feature owns
independent state — that way one feature's write does not clobber another
feature's data, and the manager thread can update one without read-modify-
writing the whole document.
