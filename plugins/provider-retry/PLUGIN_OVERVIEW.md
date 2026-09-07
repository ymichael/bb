Keep threads moving when a provider is overloaded or your subscription window is used up. This plugin watches for failed turns and schedules a retry at the right time. You do not have to come back and press send.

## What you get

- Automatic retry after a provider overload, with a short delay that doubles on each attempt.
- Automatic retry after a subscription limit, timed to the reset the provider reports.
- A queued message card on the thread that you can send now or cancel.
- A cap of four retries per turn.

## How it works

The plugin reacts to each failed turn. It only retries overload errors and subscription-window rate limits with a known reset time. Credit and spend limits are not retried. Each retry waits a little past the reset and adds a random spread. Many threads on one account then do not wake at the same instant.

## Settings

- `Maximum automatic wait`: skip a retry when the reset is farther away than 6 hours, 24 hours, or no limit.

## CLI

- `bb provider-retry status [thread-id] [--json]`: show pending retries.
- `bb provider-retry retry <thread-id>`: send a pending retry now.
- `bb provider-retry cancel <thread-id>`: cancel a pending retry.
