---
name: share-server-links
description: "Expose a local HTTP server through BB Connect and give the user its remotely accessible URL."
---

# Share local server links via bb connect

When you start an HTTP server the user should open, give them a connect share
URL — not a localhost URL. Shares work from threads running on any enrolled
host, and the command resolves the thread's host automatically.

1. Check pairing: run `bb connect status --json`. If not paired / not
   connected, give the localhost URL and mention that `bb connect` enables
   remote URLs once paired from the getbb.app dashboard.
2. From the thread that started the HTTP server, run `bb connect expose
<port>`. It prints that host's share URL. Use `--host <name-or-id>` only
   when you intentionally need another enrolled host; outside a thread,
   sharing defaults to the machine running the bb server.
3. Give the returned URL to the user as a markdown link. It works for viewers
   who have the owner's getbb.app session; it is not a public internet link.
4. When the server stops, run `bb connect unexpose <port>` from the same
   thread (or with the same `--host`) so the share is cleaned up. Use
   `bb connect shares [--host <name-or-id>]` to inspect that host's shares.

Server-host shares use `https://<server-label>--<port>.<base-domain>` through
the server tunnel. Other enrolled hosts use
`https://<machine-label>--<port>.<base-domain>` through their daemon. If a
machine was not enrolled through Connect, expose fails with instructions to
remove and re-add it under Settings > Machines.
