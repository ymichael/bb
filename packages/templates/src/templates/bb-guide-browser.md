# Built-in browser automation

`bb browser` is the experimental core API for automation integrations controlling BB desktop tabs. The Browser Automation plugin adds its own script/session commands; another plugin can use the same core connection independently.

Start with `bb browser instances --host <host-id> --json`. For every tab/control operation provide `--host <host-id> --instance <instance-id> --generation <generation> --thread <thread-id>`. The browser host can differ from the agent host. Never infer an active desktop window.

- `tabs`: list native tabs and their control state.
- `create [--url <http(s)-url>] [--reveal]`: create a tab with a separate automation profile. Defaults: hidden, about:blank.
- `acquire <tab-ids...> --controller <label> [--ttl-ms <ms>] [--allow-personal]`: acquire exclusive tab control and open/focus the first selected tab. New tabs created through its CDP connection are also revealed. Default expiry is five minutes, maximum thirty minutes. Personal tabs require the explicit handoff flag and carry their profile's authenticated authority.
- `connection <lease-id> --output <new-file>`: write private connection JSON with mode 0600 on the CLI host. The loopback WebSocket endpoint is usable only on the browser host. Pass it privately to an integration worker; never expose it through a shared port or chat output.
- `release <lease-id>`: revoke automation while keeping tabs open.
- `reveal <tab-id>`: show the actual existing native tab.
- `capture <tab-id> --output <new-file>`: save a bounded JPEG to the CLI host without focusing the tab.
- `close <tab-id>`: explicitly close that native tab.
- `watch`: print changed tab snapshots every two seconds until interrupted. Disconnects report errors; this is not a lossless event log.

All commands support JSON output. In plugin code use `bb.sdk.experimental_desktopBrowsers`; the Plugin Guide documents the typed surface. Stop/Take over revokes native control; stopping the owning thread also releases its server control leases. Old connection generations cannot control replacement windows.

Cloud browsers are not supported. Headless Chrome on an enrolled host belongs to the Browser Automation plugin.
