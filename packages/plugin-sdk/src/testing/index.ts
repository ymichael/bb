/**
 * `@get-bb/plugin-sdk/testing` — the backend plugin test harness: a fake BB
 * plugin host (`createFakePluginHost`) whose `bb` satisfies `BbPluginApi`,
 * plus fixtures. The package ships executable JavaScript and portable
 * declarations for use from external plugin repositories.
 *
 * The frontend harness (loadPluginApp/renderSlot) lives at
 * `@get-bb/plugin-sdk/testing/app` so backend-only tests never load React.
 */
export {
  createFakePluginHost,
  PluginContextStaleError,
  type CreateFakePluginHostOptions,
  type FakeAgentToolRecord,
  type FakeCliRecord,
  type FakeHttpRouteRecord,
  type FakeLogEntry,
  type FakeLogLevel,
  type FakeMentionProviderRecord,
  type FakePluginHarness,
  type FakePluginHost,
  type FakePluginBehaviorDrivers,
  type FakePluginInspectionState,
  type FakePluginLifecycleControls,
  type FakePluginRegistrations,
  type FakeRealtimeSignal,
  type FakeScheduleRecord,
  type FakeServiceRecord,
} from "./fake-plugin-host.js";
export {
  createFakeSdk,
  type FakeSdkCall,
  type FakeSdkHarness,
  type FakeSdkOverrides,
} from "./fake-sdk.js";
export {
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "./fixtures.js";
export {
  scanPublicSdkOnly as experimental_scanPublicSdkOnly,
  type PublicSdkOnlyScan,
  type PublicSdkOnlyScanOptions,
  type PublicSdkOnlyViolation,
} from "./public-sdk-only.js";
