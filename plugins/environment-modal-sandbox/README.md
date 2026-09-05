# Modal sandbox

Creates resumable bb machines in [Modal](https://modal.com) Sandboxes. It is
an official catalog plugin, not installed by default. Installing it adds the
`modal-sandbox` machine provider; it does not add an environment provider.

Choose Modal sandbox in a project's environment picker to create a machine,
clone and register that project's checkout, and run the thread there through
the Project checkout provider. The machine remains a normal bb execution
target, so later threads can create Git worktrees or use other environment
providers on the same sandbox. You can also create a projectless sandbox from
Settings → Machines → Add machine and configure project sources later.

## Lifecycle

Core owns the machine lifecycle. After every live thread on the machine has
been idle for `idleMinutes` and no terminal is open, core asks the plugin to
stop the bb daemon, snapshot the Modal filesystem, and terminate the compute.
A later send restores compute from that snapshot and reconnects the same bb
machine before work continues.

Archiving or deleting the last thread starts a 30-day retirement grace period.
When it expires, core removes the machine's environments through their own
providers first, then asks this plugin to terminate the sandbox and delete its
snapshot. Explicit machine removal follows the same cascade. Creation is
idempotent by core's durable key, including when the sandbox enrolled before a
server or plugin crash.

## What it needs

- A Modal API token. Set its two halves in the plugin's `tokenId` and
  `tokenSecret` settings.
- A git remote when creating through the project picker, because the sandbox
  clones and registers that project. Standalone machine creation does not need
  a project.
- Codex credentials. Put `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` in the
  plugin's `environmentVariables` setting, or bake a valid root-user login
  into a custom image. The plugin installs or updates Codex and authenticates
  it while creating the machine.
- A URL the sandbox can reach this bb at.

## How the sandbox reaches this bb

Leave `serverUrl` blank to use the bb connect apex associated with this bb.
The plugin obtains a one-time machine credential, downloads `/install.sh`, and
enrols the sandbox through that tunnel.

Alternatively set `serverUrl` to a tunnel that reaches this bb's HTTP port
directly. A `bb connect expose` port-share URL is unsuitable because anonymous
sandbox requests receive its browser login instead of the installer.

The plugin validates the installer URL before it creates a sandbox. After the
machine connects, it installs or updates Codex, applies configured credentials,
and verifies provider readiness before the machine becomes available.

GitHub's common SSH remote forms are converted to HTTPS so public repositories
work without copying an SSH key. Private repositories still need credentials
in the image or injected environment.

## Settings

| Setting                | Required | What it is                                                                    |
| ---------------------- | -------- | ----------------------------------------------------------------------------- |
| `tokenId`              | yes      | The token id half of a Modal API token.                                       |
| `tokenSecret`          | yes      | The token secret half of the same token.                                      |
| `serverUrl`            | no       | A tunnel URL the sandbox can reach. Blank uses bb connect.                    |
| `appName`              | no       | The Modal app for sandboxes. Defaults to `bb-sandboxes`.                      |
| `image`                | no       | Registry tag with Node 22+, npm, git, and curl.                               |
| `environmentVariables` | no       | Secret JSON object injected into the sandbox.                                 |
| `timeoutMinutes`       | no       | Modal sandbox timeout, 1–1440 minutes.                                        |
| `idleMinutes`          | no       | Snapshot after this many idle minutes. Defaults to 15; 0 disables suspension. |
| `cpu`                  | no       | Reserved cores. Blank uses Modal's default.                                   |
| `memoryMiB`            | no       | Reserved memory in MiB. Blank uses Modal's default.                           |

## Logo and trademark

The bundled `modal-logo.svg` is the full-color `Modal-IconMark.svg` distributed
through [Modal's official brand assets](https://modal.com/brand). Modal and its
logo are trademarks of Modal Labs, Inc. The asset remains Modal's property and
is bundled only to identify the service this plugin integrates with; no license
to reuse the mark separately is granted. Use remains subject to Modal's
published terms and brand guidance.
