---
name: inline-vis
description: "Render a workspace HTML artifact inline in BB chat using the inline-vis directive."
---

# Inline HTML visualizations

When the user should see a small HTML demo, chart, or report **inline in the
assistant message**, write (or update) a workspace-relative `.html` file, then
emit this **message directive** as its own block (not inside a fenced code
block):

```text
::inline-vis{file="demo.html"}
```

## Rules

- `file` is **workspace-relative** (e.g. `demo.html`, `charts/out.html`). Never
  use absolute paths.
- `height` is optional and sets the iframe viewport height in pixels. It must be
  a whole number from 120 through 1200; omit it for the 224px default.
- Only `.html` / `.htm` files are accepted.
- Inline and external CSS/JavaScript are supported. Remote images, fonts,
  media, fetches, and WebSockets are also allowed subject to normal browser
  CORS, mixed-content, and remote-server policies. Scripts execute in an
  opaque-origin iframe and cannot access the bb page, cookies, or storage.
- Keep files small (under the sidebar preview's 5 MiB document limit).
- Emit the directive only after the file exists on disk in the current thread
  workspace.
- Do **not** put the directive inside backticks or a markdown code fence, or it
  stays literal text.
- Incomplete streaming syntax stays literal until the closing `}` arrives — emit
  a complete directive in one piece when possible.

The bb app replaces the directive with a sandboxed preview. If the plugin is
disabled or the path is invalid, users see the original directive source or an
inline error from the plugin.
