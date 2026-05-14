# Using bb on multiple devices

You can run bb on one machine — your desktop, laptop, or workstation — and use
it from a browser on any other device on the same private network. Phones,
tablets, other laptops; anything with a browser can be a control surface for
the same projects, threads, and connected hosts.

The machine running bb does the work. Other devices are just browsers.

## What you'll need

- One machine actually running bb. This is where you start the server.
- [Tailscale](https://tailscale.com/) installed and signed in on every device
  you want to use, all on the same tailnet.
- [MagicDNS](https://tailscale.com/kb/1081/magicdns) enabled (optional, but it
  gives your bb machine a stable name so you don't have to memorize an IP).

## Set it up

On the machine running bb, add the URL your other devices will use to your
`.env` file. Replace `<machine>.<tailnet>.ts.net` with that machine's Tailscale
name:

```
BB_APP_URL=http://<machine>.<tailnet>.ts.net:38886
```

If you don't use MagicDNS, the Tailscale IP works too:

```
BB_APP_URL=http://<tailscale-ip>:38886
```

Restart bb (`pnpm start`) so it picks up the new value, then open that same
URL in a browser on any other device. The project list should load and you're
in.

## Optional: use HTTPS for voice and clipboard

Plain HTTP works for browsing, reading threads, and sending prompts. But some
browser features — microphone capture for voice input, clipboard access —
only work on `https://` URLs, even when the traffic is already encrypted by
Tailscale. This mostly comes up on phones and tablets.

If you want those features, [enable HTTPS for your
tailnet](https://tailscale.com/kb/1153/enabling-https), then put bb behind
[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve):

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38886
```

Update `BB_APP_URL` in your `.env` to the HTTPS URL:

```
BB_APP_URL=https://<machine>.<tailnet>.ts.net
```

Then restart bb.

## A note on access

bb has no built-in user authentication on the server today. Tailscale ACLs
are your access boundary — keep bb on the tailnet, and don't expose it through
Tailscale Funnel or the public internet.

## If something isn't working

A few quick checks:

1. Open the `/health` endpoint at your bb URL from the device giving you
   trouble — for example, `http://<machine>.<tailnet>.ts.net:38886/health`.
   It should return `{"ok":true}`. If it doesn't, that device isn't reaching
   the server — check Tailscale on both sides.
2. Make sure `BB_APP_URL` is set to the same URL you typed into the browser.
3. Try the Tailscale IP instead of the MagicDNS name (or vice versa).
4. Phones on cellular are fine as long as Tailscale stays connected.
