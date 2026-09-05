# Backend API symbol index

Use this index to check backend, host, AI-service, and test imports.
Read the detailed backend references for behavior, fields, and examples.
Read the installed declarations for exact current signatures.

## `@get-bb/plugin-sdk`

- `PLUGIN_CLI_OUTPUT_MAX_BYTES`
- `defineRpcContract`
- `experimental_defineHostEntry`
- `BbContext`
- `BbNavigate`
- `BbPluginApi`
- `CodeOverflowMode`
- `ComposerCustomization`
- `ComposerPlusMenuItem`
- `ComposerRichTextSpec`
- `ComposerStructuredDraft`
- `ComposerView`
- `DiffProps`
- `DiffViewMode`
- `ExperimentalAppPanel`
- `ExperimentalAppPanelSurface`
- `ExperimentalDesktopBrowserAcquireInput`
- `ExperimentalDesktopBrowserCreateInput`
- `ExperimentalDesktopBrowserLease`
- `ExperimentalDesktopBrowserScope`
- `ExperimentalDesktopBrowsersArea`
- `ExperimentalDiffFileContent`
- `ExperimentalDiffFullFileContents`
- `ExperimentalFileLinkProps`
- `ExperimentalFileLocation`
- `ExperimentalFileOpenOptions`
- `ExperimentalFixedTabTargetContract`
- `ExperimentalFixedTabTargetState`
- `ExperimentalHostCallOptions`
- `ExperimentalHostClient`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignalEvent`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalLiveFileTarget`
- `ExperimentalOpenFixedTabOptions`
- `ExperimentalPermissionModePickerProps`
- `ExperimentalPluginFixedTabReference`
- `ExperimentalPluginWebSocket`
- `ExperimentalPluginWebSocketContext`
- `ExperimentalPluginWebSocketHandler`
- `ExperimentalPluginWebSocketHandlers`
- `ExperimentalProviderModelPickerProps`
- `ExperimentalProviderModelPickerRouting`
- `ExperimentalProviderModelPickerValue`
- `JsonValue`
- `MarkdownProps`
- `NewThreadComposerProps`
- `NewThreadRequest`
- `MessageDispatchHookContext`
- `MessageDispatchHookDecision`
- `PluginDispatchAttemptKind`
- `PluginDispatchEnvironmentIntent`
- `PluginDispatchExecution`
- `PluginDispatchExecutionSources`
- `PluginEnvironments` — `bb.experimental_environments`: `register` +
  `recheck` (see backend-events.md, environment providers)
- `PluginMachines` — `bb.experimental_machines.register` (see
  backend-events.md, machine providers)
- `PluginMachineProviderDeclaration`
- `PluginMachineProviderRequirements` — optional `gitRemote`
- `PluginMachineValidateDecision`
- `PluginEnvironmentProviderDeclaration`
- `PluginEnvironmentProviderRequirements` — `requires`, e.g.
  `{ gitCheckout: true }`; also `projectCheckout`, `gitRemote` and `projectless`.
  Anything else comes through the declaration's `inputs` validator
- `PluginEnvironmentValidateDecision` — `{ action: "accept" }` or
  `{ action: "refuse", message }`, the message being the caller's error
- `PluginDispatchInput`
- `PluginHookHandler`
- `PluginHookName`
- `PluginHookSignatures`
- `PluginHooks`
- `PluginTurnFailedEvent`
- `ExperimentalComposerSubmitOptions`
- `PluginAgentConfiguration`
- `PluginAgentConfigurationContext`
- `PluginAgentToolContentPart`
- `PluginAgentToolContext`
- `PluginAgentToolLabels`
- `PluginAgentToolPresentation`
- `PluginAgentToolRegistrationBase`
- `PluginAgentToolResult`
- `PluginAgentToolSelection`
- `PluginAgents`
- `PluginAiServiceDeclaration`
- `PluginAiServiceKind`
- `PluginAiServices`
- `PluginAppBuilder`
- `PluginAppComposer`
- `PluginAppContentScripts`
- `PluginAppDefinition`
- `PluginAppSetup`
- `PluginAppSlots`
- `PluginBackground`
- `PluginCli`
- `PluginCliCommandInfo`
- `PluginCliContext`
- `PluginCliExecutionResult`
- `PluginCliOutputLimitError`
- `PluginCliRegistration`
- `PluginCliResult`
- `PluginCodeThemeData`
- `PluginCodeThemeState`
- `PluginCodeThemeTokenRule`
- `PluginCommandPaletteActionContext`
- `PluginCommandPaletteActionRegistration`
- `PluginComposerApi`
- `PluginComposerMention`
- `PluginComposerScope`
- `PluginComposerTextEffect`
- `PluginComposerThreadRowStatus`
- `PluginContentScriptContext`
- `PluginContentScriptDisposer`
- `PluginContentScriptRegistration`
- `PluginDiffRendererProps`
- `PluginDiffRendererRegistration`
- `PluginEvents`
- `PluginFileOpenerProps`
- `PluginFileOpenerRegistration`
- `PluginFileOpenerSource`
- `PluginFixedTabDeclaration`
- `PluginFixedTabRegistration`
- `PluginHomepageSectionProps`
- `PluginHomepageSectionRegistration`
- `PluginHosts`
- `PluginHttp`
- `PluginHttpAuthMode`
- `PluginHttpHandler`
- `PluginInteractionCancelReason`
- `PluginInteractionRequest`
- `PluginInteractionResult`
- `PluginKvStorage`
- `PluginLogger`
- `PluginMentionItem`
- `PluginMentionProviderRegistration`
- `PluginMentionSearchContext`
- `PluginMentionTrigger`
- `PluginMessageActionContext`
- `PluginMessageActionRegistration`
- `PluginMessageDirectiveMessage`
- `PluginMessageDirectiveOpenWorkspaceFile`
- `PluginMessageDirectiveProps`
- `PluginMessageDirectiveRegistration`
- `PluginNavPanelProps`
- `PluginNavPanelRegistration`
- `PluginNewThreadPanelActionContext`
- `PluginNewThreadPanelActionRegistration`
- `PluginNewThreadPanelProps`
- `PluginPanelActionOpenOptions`
- `PluginPendingInteractionProps`
- `PluginPendingInteractionRegistration`
- `PluginPendingInteractionView`
- `PluginProviderCapabilities`
- `PluginProviderComposerAction`
- `PluginProviderDeclaration`
- `ExperimentalPluginProviderEnvContext`
- `ExperimentalPluginProviderEnvEntry`
- `ExperimentalPluginProviderEnvHealthContext`
- `ExperimentalPluginProviderEnvHealth`
- `PluginProviderExtensionKindDeclaration`
- `PluginProviderFallbackModel`
- `PluginProviderIconRegistration`
- `PluginProviderMaintenance`
- `PluginProviderModelCatalogScope`
- `PluginProviderNativeRootEntry`
- `PluginProviderNativeRoots`
- `PluginProviderOptionDescriptor`
- `PluginProviderOptionsContext`
- `PluginProviderPermissionMode`
- `PluginProviderReasoningLevel`
- `PluginProviderStrings`
- `PluginProviders`
- `PluginProvidersState`
- `PluginRealtime`
- `PluginRealtimeConnectionState`
- `PluginRpc`
- `PluginRpcCallArgs`
- `PluginRpcClient`
- `PluginRpcContract`
- `PluginRpcError`
- `PluginRpcErrorCode`
- `PluginRpcHandlers`
- `PluginRpcIssuePathSegment`
- `PluginRpcMethodContract`
- `PluginRpcResult`
- `PluginRpcValidationIssue`
- `PluginSdkApp`
- `PluginServerApi`
- `PluginSettingDescriptor`
- `PluginSettingDescriptors`
- `PluginSettingValue`
- `PluginSettings`
- `PluginSettingsHandle`
- `PluginSettingsSectionProps`
- `PluginSettingsSectionRegistration`
- `PluginSettingsState`
- `PluginSettingsValues`
- `PluginSharedPortTunnelIdentity`
- `PluginSidebarFooterActionContext`
- `PluginSidebarFooterActionProps`
- `PluginSidebarFooterActionRegistration`
- `PluginSidebarProject`
- `PluginSidebarPullRequest`
- `PluginSidebarSplitPane`
- `PluginSidebarThread`
- `PluginSidebarThreadActions`
- `PluginSidebarThreadActivity`
- `PluginSidebarThreadIndicator`
- `PluginSidebarThreadPullRequestState`
- `PluginSidebarThreadSplit`
- `PluginSidebarThreadsState`
- `PluginSourceCodeRendererProps`
- `PluginSourceCodeRendererRegistration`
- `PluginStatusApi`
- `PluginStorage`
- `PluginTargetedPanelActionOpenOptions`
- `PluginThreadEventHandler`
- `PluginThreadEventName`
- `PluginThreadEventPayloads`
- `PluginThreadHeaderActionProps`
- `PluginThreadHeaderActionRegistration`
- `PluginThreadListProps`
- `PluginThreadListRegistration`
- `PluginThreadPanelActionContext`
- `PluginThreadPanelActionRegistration`
- `PluginThreadPanelProps`
- `PluginTimelineRendererProps`
- `PluginTimelineRendererRegistration`
- `PluginTimelineRendererRow`
- `PluginTimelineRowPresentation`
- `PluginTimelineRowStatus`
- `PluginUi`
- `SourceCodeLineRange`
- `SourceCodeProps`
- `StandardSchemaV1`
- `StandardSchemaV1InferInput`
- `StandardSchemaV1InferOutput`
- `StandardSchemaV1Issue`
- `StandardSchemaV1Result`
- `ThreadChatMessageAction`
- `ThreadChatMessageReference`
- `ThreadChatProps`
- `UrlLinkProps`

## `@get-bb/plugin-sdk/environment-provider`

- `PluginEnvironmentProviderAvailabilityContext` and
  `PluginEnvironmentProviderAvailability` — context and result for a
  declaration's optional `availability` method
- `PluginEnvironmentProviderDefinition` — idempotent long-running `create`
  and `remove`, plus optional `validate`, `availability`, `inputs` and policy
- `PluginEnvironmentProviderInputsSchema` — the `inputs` type parameter:
  a Standard Schema v1 validator (a zod schema is one), or `undefined` for
  `inputs: null` in `create`
- `PluginEnvironmentProviderPolicy` — `retireGraceMs`, `removeRetryMs`,
  `transientRetryMs`, `transientRetryLimit`, `pathKeys`, `createTimeoutMs`
- `PluginEnvironmentProviderValidateContext` — the `validate` context
  typed from `requires` and `inputs`, like the create context
- `PluginEnvironmentProviderCreateContext` — a replacement create's
  `previous.resource` is the provider's private JSON handle
- `PluginEnvironmentProviderCreateResult` — `created` names the path and may
  carry the private, 16 KiB-capped JSON `resource`; the selected machine owns
  the host identity
- `PluginEnvironmentProviderProgress` — durable `step` and `log` updates
- `PluginEnvironmentProviderRemoveContext` — includes the private
  `resource` returned by the launch that made the environment
- `PluginEnvironmentProviderRemoveResult`

## `@get-bb/plugin-sdk/machine-provider`

- `PluginMachineProviderDefinition` — id, display, optional icon, inputs, availability,
  validation, optional picker sugar, policy, create, optional paired
  suspend/resume, and remove
- `PluginMachineProviderInputsSchema`
- `PluginMachineProviderPolicy` — idle suspension, retirement, and removal retry
- `PluginMachineProviderEnvironmentRow`
- `PluginMachineProviderAvailabilityContext`
- `PluginMachineProviderAvailability`
- `PluginMachineProviderValidateContext`
- `PluginMachineProviderCreateContext`
- `PluginMachineProviderCreateResult`
- `PluginMachineProviderLifecycleContext`
- `PluginMachineProviderSuspendContext` — suspend context with a durable
  `checkpoint` resource callback
- `PluginMachineProviderProgress`
- `PluginMachineProviderResourceResult`
- `PluginMachineProviderRemoveResult`

## `@get-bb/plugin-sdk/ai-services`

- `experimental_aiInferenceCompleteInputSchema`
- `experimental_aiInferenceCompleteOutputSchema`
- `experimental_aiServiceErrorCodeSchema`
- `experimental_aiServicesHostContract`
- `experimental_aiVoiceTranscribeInputSchema`
- `experimental_aiVoiceTranscribeOutputSchema`
- `ExperimentalAiInferenceCompleteInput`
- `ExperimentalAiInferenceCompleteOutput`
- `ExperimentalAiServiceErrorCode`
- `ExperimentalAiServicesHostContract`
- `ExperimentalAiVoiceTranscribeInput`
- `ExperimentalAiVoiceTranscribeOutput`

## `@get-bb/plugin-sdk/host`

- `experimental_defineHostEntry`
- `experimental_filterResolvedNativeRoots`
- `experimental_killProcessGroup` — signal a child and its process group
- `experimental_killProcessesWithCwdUnder` — reap processes whose cwd is under a
  workspace a provider is tearing down, before removing the directory
- `experimental_nativeRootsHostContract`
- `experimental_nativeRootsResolveInputSchema`
- `experimental_nativeRootsResolveOutputSchema`
- `experimental_resolveClaudePluginRoots`
- `experimental_resolveVendorPluginRoots`
- `experimental_sanitizeInheritedChildProcessEnv`
- `experimental_spawnPortableOutputProcess`
- `experimental_supportsProcessGroups`
- `ExperimentalClaudePluginRoots`
- `ExperimentalClaudePluginRootsArgs`
- `ExperimentalDroppedNativeRoot`
- `ExperimentalFilteredNativeRoots`
- `ExperimentalHostEntry`
- `ExperimentalHostPaths`
- `ExperimentalHostRpcContext`
- `ExperimentalHostRpcHandlers`
- `ExperimentalHostSignalContract`
- `ExperimentalHostSignals`
- `ExperimentalHostWatchChange`
- `ExperimentalHostWatchChangeType`
- `ExperimentalHostWatchEvent`
- `ExperimentalHostWatchListener`
- `ExperimentalHostWatchOptions`
- `ExperimentalHostWatchSubscription`
- `ExperimentalHostWorkerLease`
- `ExperimentalNativeRootsHostContract`
- `ExperimentalNativeRootsResolveAnswer`
- `ExperimentalNativeRootsResolveInput`
- `ExperimentalNativeRootsResolveOutput`
- `ExperimentalSanitizeInheritedChildProcessEnvArgs`
- `ExperimentalVendorPlugin`
- `ExperimentalVendorPluginRoots`
- `ExperimentalVendorPluginRootsArgs`

## `@get-bb/plugin-sdk/testing`

- `ExperimentalFakeWebSocketRouteRecord`
- `ExperimentalFakeWebSocketSession`
- `PluginContextStaleError`
- `createFakePluginHost`
- `createFakeSdk`
- `experimental_scanPublicSdkOnly`
- `makeMessageDispatchHookContext`
- `makePluginAgentConfigurationContext`
- `makeQueueEntry`
- `makeThreadResponse`
- `makeTurnFailedEvent`
- `CreateFakePluginHostOptions`
- `FakeAgentToolRecord`
- `FakeCliRecord`
- `FakeHttpRouteRecord`
- `FakeLogEntry`
- `FakeLogLevel`
- `FakeMentionProviderRecord`
- `FakePluginBehaviorDrivers`
- `ExperimentalFakeHostRpcCall`
- `FakePluginHarness`
- `FakePluginHost`
- `FakePluginInspectionState`
- `FakePluginLifecycleControls`
- `FakePluginRegistrations`
- `FakeRealtimeSignal`
- `FakeScheduleRecord`
- `FakeSdkCall`
- `FakeSdkHarness`
- `FakeSdkOverrides`
- `FakeServiceRecord`
- `PublicSdkOnlyScan`
- `PublicSdkOnlyScanOptions`
- `PublicSdkOnlyViolation`

## `@get-bb/plugin-sdk/testing/host`

- `experimental_createHostEntryHarness`
- `ExperimentalCreateHostEntryHarnessOptions`
- `ExperimentalHostEntryHarness`
- `ExperimentalHostHarnessSignal`
