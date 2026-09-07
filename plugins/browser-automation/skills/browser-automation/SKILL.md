---
name: browser-automation
description: Use the Browser Automation BB plugin to inspect and automate persistent browser pages in an explicit desktop or local headless session. Use for browser navigation, snapshots, clicking, forms, and verification screenshots.
---

Use `bb browser-automation`. Open one session, retain its session ID, then inspect,
act, and verify in short scripts.

Choose `--backend local --headless --machine <host-id>` for headless Chrome on
an enrolled host. Choose `--backend desktop --machine <host-id> --desktop
<instance-id>` for a new dedicated desktop automation tab. Starting desktop
control opens and focuses the browser panel; new pages created through that
controller are selected automatically. Headless sessions remain headless.
Resolve the explicit instance with `bb browser instances --host <host-id> --json`
first. Never silently choose a different host, mode, or login profile.
Adding `--tab <tab-id>` hands off an existing tab and its profile's logged-in
authority; do so only when the user asked to use that tab. The CLI uses the
current thread, or `--thread <id>` outside a thread. Each session belongs to
that thread.

CLI opening:

```sh
bb browser-automation open --backend local --headless --machine <host-id> --json
bb browser-automation open --backend desktop --machine <host-id> --desktop <instance-id> --json
```

Run scripts:

```sh
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); await p.snapshot()' --json
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.click("ref/e6"); await p.snapshot()' --json
bb browser-automation screenshot <session-id> --page main --json
```

Take a fresh snapshot before using refs after navigation or document changes.
Use refs from that session's DevBrowser snapshot. Do not mix agent-browser refs
or invent selectors. Prefer a cheap URL/text/snapshot check after each action;
request a screenshot when visual verification matters. Use
`await p.shot({type:"jpeg",maxEdge:960,quality:70}); undefined` inside scripts to
return a bounded JPEG file.

`run` and `screenshot` return JSON with `hostId` and `images`, where each image
has `path`, `mimeType`, `width`, and `height`. The path is in the browser session's
temporary directory on that host. Use your image-reading tool on the path when
you are on the same machine. If the browser host differs, fetch the image to
local temporary storage first (substitute the returned path and host ID):

```sh
bb file read '<image-path>' --host '<host-id>' --json | node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const file = JSON.parse(fs.readFileSync(0, "utf8"));
if (file.contentEncoding !== "base64") throw new Error("Expected binary image");
const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "browser-image-")), "capture.jpg");
fs.writeFileSync(destination, Buffer.from(file.content, "base64"), {mode: 0o600});
console.log(destination);
'
```

Read the printed local path with your image-reading tool. Do not print base64
image bytes into the conversation. Read or copy captures before closing the
session: cleanup removes its temporary directory. Remove local copies when
finished.

`pages` lists persistent pages. Runs serialize within a session. Scripts are
trusted JavaScript with Puppeteer-style DevBrowser APIs, not a sandbox.
`--script-file` requires `--script-host <host-id>` naming the source host explicitly. Browser file
operations and `localhost` refer to the browser host. Transfer files explicitly.

Stop cancels running and queued work and releases desktop control. Cancellation
and timeout stop the session too; open a new session to resume. Close disposes
owned Chrome and plugin-created desktop tabs while preserving handed-off tabs.
Close sessions after use. Five-minute idle and thirty-minute absolute expiry
apply. Timeouts default to 30 seconds, maximum 120 seconds.

An unavailable backend or a failed runtime install is an actionable setup
error, not permission to attach to a random browser. The first open on a host
installs the pinned `dev-browser` npm release into plugin-owned host storage
there and verifies its provenance and digest; it needs npm, network access, and
Chrome on that host, and can take a minute. Later opens reuse the verified
install offline. The exact pin and Chrome setup are documented in the plugin
README. Cloud browsers and arbitrary CDP endpoints are unsupported.
