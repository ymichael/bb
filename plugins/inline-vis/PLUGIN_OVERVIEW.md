See an agent's chart, demo, or report in the conversation without opening a side panel. The agent writes an HTML file to the workspace. The plugin shows that file inside the assistant message.

## What you get

- A live preview card in the message. Scripts and styles in the file run.
- A default viewport height of 224 pixels. The agent can set a height from 120 to 1200 pixels.
- A header action that opens the source HTML file in the workspace viewer.
- A clear inline error when the file is missing, too large, or not HTML.

## How it works

The agent emits a message directive that names a workspace-relative `.html` or `.htm` file:

```text
::inline-vis{file="charts/out.html" height="480"}
```

The plugin confirms the file exists in the thread workspace before it renders. Files must be UTF-8 text with a maximum size of 5 MiB. Relative assets next to the file load as usual.

The preview runs in a sandboxed iframe with an opaque origin. Scripts in the file cannot read the bb page, its cookies, or its storage.

## For agents

The bundled `inline-vis` skill teaches the agent when to emit the directive and how to write the file. No account or external service is required.
