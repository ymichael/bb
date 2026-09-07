// bb-plugin-scheduled-send backend — deliberately empty.
//
// Scheduling used to live here: the frontend read the draft and this module
// re-sent it with `sendAt`. It does not any more. `useComposer()`'s
// `experimental_submit({ sendAt })` runs the composer's own submit
// pipeline, which is the only place the draft's attachments, @-mentions and
// (on the new-thread screen) the provider, model, environment and permission
// mode selected on screen are all resolved together. A backend send could see
// none of that and would silently schedule a different message.
//
// This module survives only because a plugin manifest requires a `server`
// entry (`pluginBbManifestSchema` in packages/domain/src/plugin-manifest.ts;
// `app` and `host` are optional, `server` is not). Delete it when app-only
// plugins are supported.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function scheduledSendPlugin(_bb: BbPluginApi): void {}
