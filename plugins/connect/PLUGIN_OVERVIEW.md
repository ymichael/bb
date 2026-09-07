Open your bb from a phone or another computer. After you pair, this bb answers at `https://<handle>.getbb.app` for anyone signed in to your getbb.app account.

## What you get

- Remote access to the full bb app through a tunnel. Your bb makes an outbound connection, so you do not open ports or change your router.
- Port shares. Publish a local HTTP server, such as a dev server, at a share URL. The link opens from any device with your session.
- Pairing for the bb mobile app with a QR code or a one-time code.
- A Remote access section in Settings, and a sidebar shortcut to it, with the connection state and the remote URL.

## How it works

Get a pairing code from the getbb.app dashboard and enter it in Settings. You can also run `bb connect --code <code> --server <url>`. The plugin keeps the tunnel open in the background and reconnects after a drop. Disable the plugin to cut all remote access at once. `bb connect off` also disconnects and forgets the pairing.

## For agents

When you view bb remotely, agents are told to share servers with `bb connect expose <port>`. A localhost link would not open. The `share-server-links` skill explains the flow. Other commands: `bb connect status`, `bb connect unexpose <port>`, `bb connect shares`, `bb connect servers`, and `bb connect machine-code`.

## Requirements

A getbb.app account. Share links open only for viewers with your getbb.app session; they are not public. Mobile pairing needs the "Mobile app" experiment.
