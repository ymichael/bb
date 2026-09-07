import type { PromptInput, ThreadEvent } from "@bb/domain";
import {
  getThreadEventScopeTurnId,
  isThreadEventWithItem,
  parseNamespacedGlyph,
  threadEventSchema,
} from "@bb/domain";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_REQUEST_METHODS,
  bridgeErrorDataSchema,
  initializeResultSchema,
  negotiateGrammarVersion,
  threadIdentityResultSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  ThreadEventGrammar,
  THREAD_EVENT_GRAMMAR_RULES,
  type BridgeCapabilities,
} from "../index.js";
import { ASSEMBLER_GRAMMAR_VERSIONS } from "../assembler/delta-assembler.js";
import {
  ConformanceClient,
  nextConformanceClientRequestId,
  type JsonRpcWireMessage,
} from "./client.js";
import type { ConformanceCheckResult } from "./types.js";

export interface ConformanceSessionFixture {
  cwd: string;
  promptInput: PromptInput[];
  zeroWorkPromptInput?: PromptInput[];
  interruptiblePromptInput?: PromptInput[];
  options?: Record<string, unknown>;
  icons?: { pluginId: string; names: readonly string[] };
}

interface ScenarioContext {
  client: ConformanceClient;
  fixture: ConformanceSessionFixture;
  resolveProviderTurnId: (
    threadId: string,
    bbTurnId: string,
  ) => string | undefined;
  fork: BridgeCapabilities["fork"];
  providerThreadId?: string;
}

const IDENTITY_RESULT_SHAPE = "{ providerThreadId, sessionRestorable? }";

function identityProblem(
  parsed: z.ZodSafeParseError<unknown>,
  result: unknown,
): string {
  return `the result must be ${IDENTITY_RESULT_SHAPE} — the runtime adopts no session without providerThreadId on the result (a thread/identity notification does not substitute for it); issues: ${parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ")} (got ${JSON.stringify(result)})`;
}

function pass(id: string, title: string): ConformanceCheckResult {
  return { id, title, status: "pass", detail: "" };
}

function fail(
  id: string,
  title: string,
  detail: string,
): ConformanceCheckResult {
  return { id, title, status: "fail", detail };
}

function skipped(
  id: string,
  title: string,
  detail: string,
): ConformanceCheckResult {
  return { id, title, status: "skipped", detail };
}

function defaultOptions(
  fixture: ConformanceSessionFixture,
): Record<string, unknown> {
  return (
    fixture.options ?? {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    }
  );
}

function threadEvents(
  context: ScenarioContext,
  threadId: string,
): ThreadEvent[] {
  context.client.drainIntoLog();
  return context.client.events
    .filter((entry) => entry.threadId === threadId)
    .map((entry) => entry.event);
}

const persistedEventSchema = z.preprocess(
  (event) => JSON.parse(JSON.stringify(event)),
  threadEventSchema,
);

function errorCode(message: JsonRpcWireMessage | null): number | undefined {
  const code = message?.error?.code;
  return typeof code === "number" ? code : undefined;
}

const ITEM_OPENS_BEFORE_DELTA_TITLE =
  "every item's first event is item/started";

export function checkItemOpensBeforeDelta(
  events: ThreadEvent[],
): ConformanceCheckResult {
  const grammar = new ThreadEventGrammar();
  for (const event of events) {
    const result = grammar.observe(event);
    if (
      result.kind === "violation" &&
      result.rule === THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta
    ) {
      return fail(
        THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
        ITEM_OPENS_BEFORE_DELTA_TITLE,
        result.reason,
      );
    }
  }
  if (events.length === 0) {
    return skipped(
      "item/opens-before-delta",
      ITEM_OPENS_BEFORE_DELTA_TITLE,
      "no events to inspect",
    );
  }
  return pass("item/opens-before-delta", ITEM_OPENS_BEFORE_DELTA_TITLE);
}

const PRESENTATION_ICONS_DECLARED_ID = "presentation/icon-namespaced-declared";
const PRESENTATION_ICONS_DECLARED_TITLE =
  "every namespaced presentation glyph names one of the plugin's declared icons";

export function checkPresentationIconsDeclared(
  events: ThreadEvent[],
  icons: { pluginId: string; names: readonly string[] },
): ConformanceCheckResult {
  const declared = new Set(icons.names);
  let inspected = 0;
  for (const event of events) {
    if (!isThreadEventWithItem(event)) {
      continue;
    }
    if (event.item.type === "toolCall" && event.item.server === "bb") {
      continue;
    }
    const glyph =
      "presentation" in event.item
        ? event.item.presentation?.icon.glyph
        : undefined;
    if (glyph === undefined) {
      continue;
    }
    inspected += 1;
    const parsed = parseNamespacedGlyph(glyph);
    if (parsed === null) {
      continue;
    }
    if (parsed.pluginId !== icons.pluginId || !declared.has(parsed.name)) {
      return fail(
        PRESENTATION_ICONS_DECLARED_ID,
        PRESENTATION_ICONS_DECLARED_TITLE,
        `${event.type} ${event.item.type} "${event.item.id}" names presentation.icon "${glyph}", which is not an icon declared by plugin "${icons.pluginId}" (declared: ${
          icons.names.length === 0 ? "none" : icons.names.join(", ")
        }); the server would persist it as provider/unhandled`,
      );
    }
  }
  if (inspected === 0) {
    return skipped(
      PRESENTATION_ICONS_DECLARED_ID,
      PRESENTATION_ICONS_DECLARED_TITLE,
      "no item carried a presentation to inspect",
    );
  }
  return pass(
    PRESENTATION_ICONS_DECLARED_ID,
    PRESENTATION_ICONS_DECLARED_TITLE,
  );
}

export async function runRpcHygieneScenarios(
  client: ConformanceClient,
): Promise<ConformanceCheckResult[]> {
  const results: ConformanceCheckResult[] = [];

  let unknownMethodsAnswered = false;
  {
    const id = client.request("bb/conformance/definitely-unknown-method", {});
    const response = await client.waitForResponse(id);
    const title = "unknown method answers METHOD_NOT_FOUND";
    if (response === null) {
      results.push(
        fail("rpc/unknown-method", title, "request was silently dropped"),
      );
    } else if (
      errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND
    ) {
      unknownMethodsAnswered = true;
      results.push(pass("rpc/unknown-method", title));
    } else {
      unknownMethodsAnswered = true;
      results.push(
        fail(
          "rpc/unknown-method",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`,
        ),
      );
    }
  }

  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {});
    const response = await client.waitForResponse(id);
    const title = "schema-invalid params answer INVALID_PARAMS, never dropped";
    if (response === null) {
      results.push(
        fail("rpc/invalid-params", title, "request was silently dropped"),
      );
    } else if (errorCode(response) === BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS) {
      results.push(pass("rpc/invalid-params", title));
    } else {
      results.push(
        fail(
          "rpc/invalid-params",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`,
        ),
      );
    }
  }

  {
    const title = "a non-JSON line is ignored and the bridge stays alive";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/non-json-ignored",
          title,
          "aliveness probe unavailable: bridge drops unknown methods",
        ),
      );
    } else {
      client.sendRaw("this is { not json");
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      results.push(
        response === null
          ? fail("rpc/non-json-ignored", title, "bridge stopped answering")
          : pass("rpc/non-json-ignored", title),
      );
    }
  }

  {
    const title = "a response-shaped line is not treated as a request";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/response-not-request",
          title,
          "aliveness probe unavailable: bridge drops unknown methods",
        ),
      );
    } else {
      client.sendRaw(
        JSON.stringify({ jsonrpc: "2.0", id: 999_999, result: {} }),
      );
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      const echoed = client
        .responsesFor(999_999)
        .some((message) => message.error !== undefined);
      if (response === null) {
        results.push(
          fail("rpc/response-not-request", title, "bridge stopped answering"),
        );
      } else if (echoed) {
        results.push(
          fail(
            "rpc/response-not-request",
            title,
            "bridge answered an unsolicited response with an error",
          ),
        );
      } else {
        results.push(pass("rpc/response-not-request", title));
      }
    }
  }

  return results;
}

export interface HandshakeScenarioOutcome {
  results: ConformanceCheckResult[];
  capabilities: BridgeCapabilities | null;
}

export async function runHandshakeScenario(
  client: ConformanceClient,
): Promise<HandshakeScenarioOutcome> {
  const id = client.request(BRIDGE_REQUEST_METHODS.initialize, {
    protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
    client: { name: "bb-conformance", version: "0.0.1" },
    grammarVersions: ASSEMBLER_GRAMMAR_VERSIONS,
  });
  const response = await client.waitForResponse(id);
  const title = "initialize answers a versioned handshake with capabilities";
  const failed = (detail: string): HandshakeScenarioOutcome => ({
    results: [fail("handshake/initialize", title, detail)],
    capabilities: null,
  });
  if (response === null) {
    return failed("no response");
  }
  const parsed = initializeResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return failed(
      `result did not parse: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(
          "; ",
        )} (got ${JSON.stringify(response.result ?? response.error)})`,
    );
  }
  if (parsed.data.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION) {
    return failed(
      `bridge answered protocol version ${parsed.data.protocolVersion}; this kit (and the runtime) require ${PROVIDER_BRIDGE_PROTOCOL_VERSION}`,
    );
  }
  const [bridgeMin, bridgeMax] = parsed.data.capabilities.grammarVersions;
  if (
    negotiateGrammarVersion(
      ASSEMBLER_GRAMMAR_VERSIONS,
      parsed.data.capabilities.grammarVersions,
    ) === null
  ) {
    const [runtimeMin, runtimeMax] = ASSEMBLER_GRAMMAR_VERSIONS;
    return failed(
      `bridge reported grammarVersions [${bridgeMin}, ${bridgeMax}]; the runtime's assembler speaks [${runtimeMin}, ${runtimeMax}], so the handshake would be refused`,
    );
  }
  return {
    results: [
      pass("handshake/initialize", title),
      ...(await runSkillsConfigureDeclaredScenario(
        client,
        parsed.data.capabilities.skills.configure,
      )),
    ],
    capabilities: parsed.data.capabilities,
  };
}

const SKILLS_CONFIGURE_DECLARED_ID = "skills/configure-declared";
const SKILLS_CONFIGURE_DECLARED_TITLE =
  "skills/configure is handled iff the handshake declares skills.configure";

async function runSkillsConfigureDeclaredScenario(
  client: ConformanceClient,
  declared: boolean,
): Promise<ConformanceCheckResult[]> {
  const id = client.request(BRIDGE_REQUEST_METHODS.skillsConfigure, {
    roots: [],
  });
  const response = await client.waitForResponse(id);
  if (response === null) {
    return [
      fail(
        SKILLS_CONFIGURE_DECLARED_ID,
        SKILLS_CONFIGURE_DECLARED_TITLE,
        "skills/configure was not answered",
      ),
    ];
  }
  if (declared) {
    return response.error === undefined
      ? [pass(SKILLS_CONFIGURE_DECLARED_ID, SKILLS_CONFIGURE_DECLARED_TITLE)]
      : [
          fail(
            SKILLS_CONFIGURE_DECLARED_ID,
            SKILLS_CONFIGURE_DECLARED_TITLE,
            `the handshake declares skills.configure but the request failed: ${JSON.stringify(response.error)}`,
          ),
        ];
  }
  return errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND
    ? [pass(SKILLS_CONFIGURE_DECLARED_ID, SKILLS_CONFIGURE_DECLARED_TITLE)]
    : [
        fail(
          SKILLS_CONFIGURE_DECLARED_ID,
          SKILLS_CONFIGURE_DECLARED_TITLE,
          `the handshake does not declare skills.configure, yet the bridge answered the request with ${JSON.stringify(response.error ?? response.result)}; declare it (the runtime never sends an undeclared request)`,
        ),
      ];
}

export async function runSessionLifecycleScenarios(
  context: ScenarioContext,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  const results: ConformanceCheckResult[] = [];
  const threadId = "thr_conformance_1";

  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
      threadId,
      cwd: fixture.cwd,
      options: defaultOptions(fixture),
      instructionMode: "append",
    });
    const response = await client.waitForResponse(id);
    const title = "thread/start returns a provider thread identity";
    if (response === null) {
      results.push(fail("session/start-identity", title, "no response"));
    } else if (response.error !== undefined) {
      results.push(
        fail(
          "session/start-identity",
          title,
          `error: ${JSON.stringify(response.error)}`,
        ),
      );
    } else {
      const parsed = threadIdentityResultSchema.safeParse(response.result);
      if (!parsed.success) {
        results.push(
          fail(
            "session/start-identity",
            title,
            identityProblem(parsed, response.result),
          ),
        );
      } else {
        context.providerThreadId = parsed.data.providerThreadId;
        results.push(pass("session/start-identity", title));
      }
    }
  }

  const startSkipDetail = "prerequisite session/start-identity failed";

  if (context.providerThreadId === undefined) {
    results.push(
      skipped(
        "turn/lifecycle",
        "an accepted turn starts and settles",
        startSkipDetail,
      ),
      skipped(
        "events/schema-valid",
        "every assembled event is a valid ThreadEvent",
        startSkipDetail,
      ),
      skipped(
        "item/opens-before-delta",
        "every item's first event is item/started",
        startSkipDetail,
      ),
    );
  } else {
    const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: fixture.promptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture),
    });

    const started = await client.waitFor(() =>
      threadEvents(context, threadId).find(
        (event) => event.type === "turn/started",
      ),
    );
    const completed = await client.waitFor(() =>
      threadEvents(context, threadId).find(
        (event) => event.type === "turn/completed",
      ),
    );
    await client.waitForResponse(id);

    const title = "an accepted turn starts and settles";
    if (started === undefined || started === null) {
      results.push(
        fail("turn/lifecycle", title, "no turn/started event arrived"),
      );
    } else if (completed === undefined || completed === null) {
      results.push(
        fail("turn/lifecycle", title, "turn never settled (no turn/completed)"),
      );
    } else {
      results.push(pass("turn/lifecycle", title));
    }

    {
      client.drainIntoLog();
      const invalid = client.events.filter(
        (entry) => !persistedEventSchema.safeParse(entry.event).success,
      );
      const title2 = "every assembled event is a valid ThreadEvent";
      results.push(
        invalid.length === 0
          ? pass("events/schema-valid", title2)
          : fail(
              "events/schema-valid",
              title2,
              `${invalid.length} assembled event(s) failed validation; first: ${JSON.stringify(invalid[0]?.event).slice(0, 400)}`,
            ),
      );
    }

    results.push(checkItemOpensBeforeDelta(threadEvents(context, threadId)));

    if (fixture.icons !== undefined) {
      results.push(
        checkPresentationIconsDeclared(
          threadEvents(context, threadId),
          fixture.icons,
        ),
      );
    }
  }

  if (context.providerThreadId === undefined) {
    results.push(
      skipped(
        "stop/release-not-interrupted",
        "a release stop never fabricates an interruption",
        startSkipDetail,
      ),
    );
  } else {
    const before = threadEvents(context, threadId).length;
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const response = await client.waitForResponse(id);
    await client.settle(150);
    const after = threadEvents(context, threadId).slice(before);
    const fabricated = after.find(
      (event) =>
        event.type === "system/thread/interrupted" ||
        (event.type === "turn/completed" && event.status === "interrupted"),
    );
    const title = "a release stop never fabricates an interruption";
    if (response === null) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          "no response to thread/stop",
        ),
      );
    } else if (response.error !== undefined) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `error: ${JSON.stringify(response.error)}`,
        ),
      );
    } else if (fabricated !== undefined) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `release emitted ${fabricated.type}`,
        ),
      );
    } else {
      results.push(pass("stop/release-not-interrupted", title));
    }
  }

  const uniquenessTitle = "turn and item ids never repeat across a resume";
  if (context.providerThreadId === undefined) {
    results.push(
      skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, startSkipDetail),
      skipped("session/resume-id-uniqueness", uniquenessTitle, startSkipDetail),
    );
  } else {
    const resumeId = client.request(BRIDGE_REQUEST_METHODS.threadResume, {
      threadId,
      cwd: fixture.cwd,
      providerThreadId: context.providerThreadId,
      options: defaultOptions(fixture),
      instructionMode: "append",
    });
    const resumeResponse = await client.waitForResponse(resumeId);
    const title = uniquenessTitle;
    const resumed =
      resumeResponse === null || resumeResponse.error !== undefined
        ? null
        : threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (resumed === null) {
      const detail =
        resumeResponse === null
          ? "thread/resume was not answered"
          : `thread/resume failed: ${JSON.stringify(resumeResponse.error)}`;
      results.push(
        skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, detail),
        skipped("session/resume-id-uniqueness", title, detail),
      );
    } else if (!resumed.success) {
      results.push(
        fail(
          RESUME_IDENTITY_ID,
          RESUME_IDENTITY_TITLE,
          identityProblem(resumed, resumeResponse?.result),
        ),
        skipped(
          "session/resume-id-uniqueness",
          title,
          "prerequisite session/resume-identity failed",
        ),
      );
    } else {
      context.providerThreadId = resumed.data.providerThreadId;
      results.push(pass(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE));
      const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
        threadId,
        providerThreadId: context.providerThreadId,
        input: fixture.promptInput,
        clientRequestId: nextConformanceClientRequestId(),
        options: defaultOptions(fixture),
      });
      const secondCompleted = await client.waitFor(() => {
        const completions = threadEvents(context, threadId).filter(
          (event) => event.type === "turn/completed",
        );
        return completions.length >= 2 ? completions[1] : undefined;
      });
      await client.waitForResponse(turnId);

      if (secondCompleted === null) {
        results.push(
          fail(
            "session/resume-id-uniqueness",
            title,
            "the post-resume turn never settled",
          ),
        );
      } else {
        const events = threadEvents(context, threadId);
        const turnIds: string[] = [];
        const itemIds: string[] = [];
        for (const event of events) {
          if (event.type === "turn/started" && event.scope.kind === "turn") {
            turnIds.push(event.scope.turnId);
          }
          if (event.type === "item/started") {
            itemIds.push(event.item.id);
          }
        }
        const duplicateTurn = turnIds.find(
          (value, index) => turnIds.indexOf(value) !== index,
        );
        const duplicateItem = itemIds.find(
          (value, index) => itemIds.indexOf(value) !== index,
        );
        if (duplicateTurn !== undefined || duplicateItem !== undefined) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              duplicateTurn !== undefined
                ? `turn id reused across resume: ${duplicateTurn}`
                : `item id reused across resume: ${String(duplicateItem)}`,
            ),
          );
        } else if (turnIds.length < 2) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              `expected two turns, saw ${turnIds.length}`,
            ),
          );
        } else {
          results.push(pass("session/resume-id-uniqueness", title));
        }
      }
    }
  }

  results.push(...(await runForkIdentityScenario(context, threadId)));
  results.push(...(await runZeroWorkTurnScenario(context, threadId)));
  results.push(...(await runArchivedResumeRecoveryScenario(context, threadId)));
  results.push(...(await runThreadsIndependentScenario(context, threadId)));
  results.push(...(await runInterruptStopScenario(context, threadId)));

  if (context.providerThreadId !== undefined) {
    const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await client.waitForResponse(releaseId);
  }

  return results;
}

const RESUME_IDENTITY_ID = "session/resume-identity";
const RESUME_IDENTITY_TITLE =
  "thread/resume returns a provider thread identity";

const FORK_IDENTITY_ID = "session/fork-identity";
const FORK_IDENTITY_TITLE =
  "thread/fork returns a provider thread identity for the forked session";

async function runForkIdentityScenario(
  context: ScenarioContext,
  threadId: string,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  if (context.fork === "none") {
    return [];
  }
  if (context.providerThreadId === undefined) {
    return [
      skipped(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "prerequisite session/start-identity failed",
      ),
    ];
  }
  const forkThreadId = `${threadId}_fork`;
  const forkId = client.request(BRIDGE_REQUEST_METHODS.threadFork, {
    threadId: forkThreadId,
    cwd: fixture.cwd,
    sourceProviderThreadId: context.providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append",
  });
  const response = await client.waitForResponse(forkId);
  if (response === null) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "thread/fork was not answered",
      ),
    ];
  }
  if (response.error !== undefined) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        `the handshake declares fork "${context.fork}", yet forking the lifecycle session at its tip failed: ${JSON.stringify(response.error)}`,
      ),
    ];
  }
  const parsed = threadIdentityResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        identityProblem(parsed, response.result),
      ),
    ];
  }
  const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: forkThreadId,
    providerThreadId: parsed.data.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await client.waitForResponse(releaseId);
  return [pass(FORK_IDENTITY_ID, FORK_IDENTITY_TITLE)];
}

const THREADS_INDEPENDENT_ID = "session/threads-independent";
const THREADS_INDEPENDENT_TITLE =
  "requests on different threads are independent";

async function runThreadsIndependentScenario(
  context: ScenarioContext,
  threadId: string,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === undefined) {
    return [];
  }
  if (context.providerThreadId === undefined) {
    return [
      skipped(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "prerequisite session/start-identity failed",
      ),
    ];
  }
  const startedBefore = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/started",
  ).length;
  const holdId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: interruptiblePromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture),
  });
  const held = await client.waitFor(() => {
    const starts = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started",
    );
    return starts.length > startedBefore ? starts[startedBefore] : undefined;
  });
  await client.waitForResponse(holdId);
  if (held === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the interruptible prompt never opened a turn",
      ),
    ];
  }

  const otherThreadId = `${threadId}_other`;
  const startId = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
    threadId: otherThreadId,
    cwd: fixture.cwd,
    options: defaultOptions(fixture),
    instructionMode: "append",
  });
  const startResponse = await client.waitForResponse(startId);
  const startResult = threadIdentityResultSchema.safeParse(
    startResponse?.result,
  );
  if (startResponse === null || !startResult.success) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        `the second thread did not start while the first held a turn: ${JSON.stringify(startResponse?.error ?? startResponse?.result)}`,
      ),
    ];
  }
  const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    input: fixture.promptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture),
  });
  const completed = await client.waitFor(() =>
    threadEvents(context, otherThreadId).find(
      (event) => event.type === "turn/completed",
    ),
  );
  await client.waitForResponse(turnId);
  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await client.waitForResponse(stopId);

  if (completed === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the second thread's turn never completed while the first thread held a turn",
      ),
    ];
  }
  const firstStillOpen = !threadEvents(context, threadId).some(
    (event) =>
      event.type === "turn/completed" &&
      getThreadEventScopeTurnId(event.scope) ===
        getThreadEventScopeTurnId(held.scope),
  );
  if (!firstStillOpen) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the held turn on the first thread settled while the second thread ran",
      ),
    ];
  }
  return [pass(THREADS_INDEPENDENT_ID, THREADS_INDEPENDENT_TITLE)];
}

const INTERRUPT_SETTLES_ID = "stop/interrupt-settles-before-result";
const INTERRUPT_SETTLES_TITLE =
  "thread/stop {interrupt} settles the turn before it is answered";

async function runInterruptStopScenario(
  context: ScenarioContext,
  threadId: string,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === undefined) {
    return [];
  }
  if (context.providerThreadId === undefined) {
    return [
      skipped(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "prerequisite session/start-identity failed",
      ),
    ];
  }
  let started = openTurnStart(context, threadId);
  if (started === undefined) {
    const startedBefore = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started",
    ).length;
    const turnRequestId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: interruptiblePromptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture),
    });
    started =
      (await client.waitFor(() => {
        const starts = threadEvents(context, threadId).filter(
          (event) => event.type === "turn/started",
        );
        return starts.length > startedBefore
          ? starts[startedBefore]
          : undefined;
      })) ?? undefined;
    await client.waitForResponse(turnRequestId);
  }
  if (started === undefined || started.scope.kind !== "turn") {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interruptible prompt never opened a turn",
      ),
    ];
  }
  const bbTurnId = started.scope.turnId;
  const providerTurnId =
    context.resolveProviderTurnId(threadId, bbTurnId) ?? bbTurnId;

  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId,
    providerThreadId: context.providerThreadId,
    intent: "interrupt",
    activeTurnId: providerTurnId,
  });
  const stopResponse = await client.waitForResponse(stopId);
  if (stopResponse === null) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "thread/stop was not answered",
      ),
    ];
  }
  if (stopResponse.error !== undefined) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        `thread/stop failed: ${JSON.stringify(stopResponse.error)}`,
      ),
    ];
  }
  const responseIndex = client.log.indexOf(stopResponse);
  const completedIndex =
    client.events.find(
      (entry) =>
        entry.threadId === threadId &&
        entry.event.type === "turn/completed" &&
        getThreadEventScopeTurnId(entry.event.scope) === bbTurnId,
    )?.logIndex ?? -1;
  if (completedIndex === -1) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interrupted turn never reached turn/completed",
      ),
    ];
  }
  if (completedIndex > responseIndex) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "turn/completed arrived after the thread/stop response; the runtime had already detached the thread",
      ),
    ];
  }
  return [pass(INTERRUPT_SETTLES_ID, INTERRUPT_SETTLES_TITLE)];
}

const SESSION_ARCHIVED_RECOVERY_ID = "recovery/session-archived";
const SESSION_ARCHIVED_RECOVERY_TITLE =
  "resuming an archived session is rejected with a sessionArchived hint";

async function runArchivedResumeRecoveryScenario(
  context: ScenarioContext,
  threadId: string,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  const providerThreadId = context.providerThreadId;
  if (providerThreadId === undefined) {
    return [
      skipped(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "prerequisite session/start-identity failed",
      ),
    ];
  }
  const archiveId = client.request(BRIDGE_REQUEST_METHODS.threadArchive, {
    threadId,
    providerThreadId,
  });
  const archiveResponse = await client.waitForResponse(archiveId);
  if (archiveResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/archive was not answered",
      ),
    ];
  }
  if (archiveResponse.error !== undefined) {
    return [];
  }

  const resumeParams = {
    threadId,
    cwd: fixture.cwd,
    providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append",
  };
  const resumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams,
  );
  const resumeResponse = await client.waitForResponse(resumeId);

  const unarchiveId = client.request(BRIDGE_REQUEST_METHODS.threadUnarchive, {
    threadId,
    providerThreadId,
  });
  await client.waitForResponse(unarchiveId);

  if (resumeResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/resume of the archived session was not answered",
      ),
    ];
  }
  if (resumeResponse.error === undefined) {
    const resumed = threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (!resumed.success) {
      return [
        fail(
          SESSION_ARCHIVED_RECOVERY_ID,
          SESSION_ARCHIVED_RECOVERY_TITLE,
          `the archived session was resumed with a result the runtime cannot adopt: ${identityProblem(resumed, resumeResponse.result)}`,
        ),
      ];
    }
    context.providerThreadId = resumed.data.providerThreadId;
    return [];
  }
  const reResumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams,
  );
  const reResumeResponse = await client.waitForResponse(reResumeId);

  const data = bridgeErrorDataSchema.safeParse(resumeResponse.error.data);
  const kind = data.success ? data.data.recovery?.kind : undefined;
  if (kind !== "sessionArchived") {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        `the rejection carried ${
          kind === undefined ? "no recovery hint" : `kind "${kind}"`
        }: ${JSON.stringify(resumeResponse.error)}`,
      ),
    ];
  }
  const notBack = (detail: string): ConformanceCheckResult[] => [
    fail(
      SESSION_ARCHIVED_RECOVERY_ID,
      SESSION_ARCHIVED_RECOVERY_TITLE,
      `the session did not come back: ${detail}`,
    ),
  ];
  if (reResumeResponse === null) {
    return notBack("thread/resume after thread/unarchive was not answered");
  }
  if (reResumeResponse.error !== undefined) {
    return notBack(
      `thread/resume after thread/unarchive failed: ${JSON.stringify(reResumeResponse.error)}`,
    );
  }
  const reResumed = threadIdentityResultSchema.safeParse(
    reResumeResponse.result,
  );
  if (!reResumed.success) {
    return notBack(identityProblem(reResumed, reResumeResponse.result));
  }
  context.providerThreadId = reResumed.data.providerThreadId;
  return [pass(SESSION_ARCHIVED_RECOVERY_ID, SESSION_ARCHIVED_RECOVERY_TITLE)];
}

const SETTLES_WITHOUT_ACTIVITY_ID = "turn/settles-without-activity";
const SETTLES_WITHOUT_ACTIVITY_TITLE =
  "a turn the provider completes without activity still settles";

async function runZeroWorkTurnScenario(
  context: ScenarioContext,
  threadId: string,
): Promise<ConformanceCheckResult[]> {
  const { client, fixture } = context;
  const zeroWorkPromptInput = fixture.zeroWorkPromptInput;
  if (zeroWorkPromptInput === undefined) {
    return [];
  }
  if (context.providerThreadId === undefined) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "prerequisite session/start-identity failed",
      ),
    ];
  }

  const before = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/completed",
  ).length;
  const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: zeroWorkPromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture),
  });
  const settled = await client.waitFor(() => {
    const completions = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/completed",
    );
    return completions.length > before ? completions[before] : undefined;
  });
  const response = await client.waitForResponse(id);

  if (response !== null && response.error !== undefined) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        `the zero-work prompt was rejected: ${JSON.stringify(response.error)}`,
      ),
    ];
  }
  if (settled === null) {
    return [
      fail(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "the accepted zero-work turn never emitted a terminal turn/completed",
      ),
    ];
  }
  return [pass(SETTLES_WITHOUT_ACTIVITY_ID, SETTLES_WITHOUT_ACTIVITY_TITLE)];
}

function openTurnStart(
  context: ScenarioContext,
  threadId: string,
): ThreadEvent | undefined {
  const events = threadEvents(context, threadId);
  const completedTurnIds = new Set(
    events
      .filter((event) => event.type === "turn/completed")
      .map((event) => getThreadEventScopeTurnId(event.scope)),
  );
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "turn/started" &&
        !completedTurnIds.has(getThreadEventScopeTurnId(event.scope)),
    );
}
