import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import {
  pendingInteractionPayloadSchema,
  permissionEscalationValues,
  permissionModeValues,
  runtimePermissionPolicySchema,
} from "@bb/domain";
import type {
  ApprovalPendingInteractionPayload,
  PendingInteractionApprovalDecision,
  PendingInteractionApprovalSubject,
  PermissionEscalation,
  PermissionMode,
  RuntimePermissionPolicy,
} from "@bb/domain";
import { bridgeCapabilitiesSchema } from "@bb/provider-bridge-protocol";
import {
  parseJsonRpcLine,
  shouldAutoDenyInteractiveRequest,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { JsonRpcMessage } from "@bb/provider-bridge-protocol/bridge-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BridgeProtocolAdapter } from "./bridge-protocol-adapter.js";
import { createProviderForId } from "./provider-registry.js";
import { handleRuntimeProviderRequest } from "./runtime-provider-requests.js";
import {
  createScriptedEchoLaunch,
  fullRuntimeOptions,
} from "./test/runtime-test-harness.js";
import type { AgentRuntimeExecutionOptions } from "./types.js";

const POLICY_KEYS = [
  "accept-edits/ask",
  "accept-edits/deny",
  "auto/ask",
  "auto/deny",
  "full/-",
] as const;
type PolicyKey = (typeof POLICY_KEYS)[number];

const SUBJECT_KINDS = [
  "command",
  "file_change",
  "permission_grant",
  "plan",
  "tool_use",
] as const;
type SubjectKind = (typeof SUBJECT_KINDS)[number];

const ENFORCERS = ["runtime", "provider"] as const;
type Enforcer = (typeof ENFORCERS)[number];

const DENY_AVAILABILITY = ["deny-available", "deny-unavailable"] as const;
type DenyAvailability = (typeof DENY_AVAILABILITY)[number];

type CellKey = `${PolicyKey}|${SubjectKind}|${Enforcer}|${DenyAvailability}`;

type Outcome = "forward" | "auto-deny" | "encode-error";

const EXPECTED = {
  "accept-edits/ask|command|runtime|deny-available": "forward",
  "accept-edits/ask|command|runtime|deny-unavailable": "forward",
  "accept-edits/ask|command|provider|deny-available": "forward",
  "accept-edits/ask|command|provider|deny-unavailable": "forward",
  "accept-edits/ask|file_change|runtime|deny-available": "forward",
  "accept-edits/ask|file_change|runtime|deny-unavailable": "forward",
  "accept-edits/ask|file_change|provider|deny-available": "forward",
  "accept-edits/ask|file_change|provider|deny-unavailable": "forward",
  "accept-edits/ask|permission_grant|runtime|deny-available": "forward",
  "accept-edits/ask|permission_grant|runtime|deny-unavailable": "forward",
  "accept-edits/ask|permission_grant|provider|deny-available": "forward",
  "accept-edits/ask|permission_grant|provider|deny-unavailable": "forward",
  "accept-edits/ask|plan|runtime|deny-available": "forward",
  "accept-edits/ask|plan|runtime|deny-unavailable": "forward",
  "accept-edits/ask|plan|provider|deny-available": "forward",
  "accept-edits/ask|plan|provider|deny-unavailable": "forward",
  "accept-edits/deny|command|runtime|deny-available": "auto-deny",
  "accept-edits/deny|command|runtime|deny-unavailable": "encode-error",
  "accept-edits/deny|command|provider|deny-available": "forward",
  "accept-edits/deny|command|provider|deny-unavailable": "forward",
  "accept-edits/deny|file_change|runtime|deny-available": "auto-deny",
  "accept-edits/deny|file_change|runtime|deny-unavailable": "encode-error",
  "accept-edits/deny|file_change|provider|deny-available": "forward",
  "accept-edits/deny|file_change|provider|deny-unavailable": "forward",
  "accept-edits/deny|permission_grant|runtime|deny-available": "auto-deny",
  "accept-edits/deny|permission_grant|runtime|deny-unavailable": "encode-error",
  "accept-edits/deny|permission_grant|provider|deny-available": "forward",
  "accept-edits/deny|permission_grant|provider|deny-unavailable": "forward",
  "accept-edits/deny|plan|runtime|deny-available": "auto-deny",
  "accept-edits/deny|plan|runtime|deny-unavailable": "encode-error",
  "accept-edits/deny|plan|provider|deny-available": "forward",
  "accept-edits/deny|plan|provider|deny-unavailable": "forward",
  "auto/ask|command|runtime|deny-available": "forward",
  "auto/ask|command|runtime|deny-unavailable": "forward",
  "auto/ask|command|provider|deny-available": "forward",
  "auto/ask|command|provider|deny-unavailable": "forward",
  "auto/ask|file_change|runtime|deny-available": "forward",
  "auto/ask|file_change|runtime|deny-unavailable": "forward",
  "auto/ask|file_change|provider|deny-available": "forward",
  "auto/ask|file_change|provider|deny-unavailable": "forward",
  "auto/ask|permission_grant|runtime|deny-available": "forward",
  "auto/ask|permission_grant|runtime|deny-unavailable": "forward",
  "auto/ask|permission_grant|provider|deny-available": "forward",
  "auto/ask|permission_grant|provider|deny-unavailable": "forward",
  "auto/ask|plan|runtime|deny-available": "forward",
  "auto/ask|plan|runtime|deny-unavailable": "forward",
  "auto/ask|plan|provider|deny-available": "forward",
  "auto/ask|plan|provider|deny-unavailable": "forward",
  "auto/deny|command|runtime|deny-available": "auto-deny",
  "auto/deny|command|runtime|deny-unavailable": "encode-error",
  "auto/deny|command|provider|deny-available": "forward",
  "auto/deny|command|provider|deny-unavailable": "forward",
  "auto/deny|file_change|runtime|deny-available": "auto-deny",
  "auto/deny|file_change|runtime|deny-unavailable": "encode-error",
  "auto/deny|file_change|provider|deny-available": "forward",
  "auto/deny|file_change|provider|deny-unavailable": "forward",
  "auto/deny|permission_grant|runtime|deny-available": "auto-deny",
  "auto/deny|permission_grant|runtime|deny-unavailable": "encode-error",
  "auto/deny|permission_grant|provider|deny-available": "forward",
  "auto/deny|permission_grant|provider|deny-unavailable": "forward",
  "auto/deny|plan|runtime|deny-available": "auto-deny",
  "auto/deny|plan|runtime|deny-unavailable": "encode-error",
  "auto/deny|plan|provider|deny-available": "forward",
  "auto/deny|plan|provider|deny-unavailable": "forward",
  "accept-edits/ask|tool_use|runtime|deny-available": "forward",
  "accept-edits/ask|tool_use|runtime|deny-unavailable": "forward",
  "accept-edits/ask|tool_use|provider|deny-available": "forward",
  "accept-edits/ask|tool_use|provider|deny-unavailable": "forward",
  "accept-edits/deny|tool_use|runtime|deny-available": "auto-deny",
  "accept-edits/deny|tool_use|runtime|deny-unavailable": "encode-error",
  "accept-edits/deny|tool_use|provider|deny-available": "forward",
  "accept-edits/deny|tool_use|provider|deny-unavailable": "forward",
  "auto/ask|tool_use|runtime|deny-available": "forward",
  "auto/ask|tool_use|runtime|deny-unavailable": "forward",
  "auto/ask|tool_use|provider|deny-available": "forward",
  "auto/ask|tool_use|provider|deny-unavailable": "forward",
  "auto/deny|tool_use|runtime|deny-available": "auto-deny",
  "auto/deny|tool_use|runtime|deny-unavailable": "encode-error",
  "auto/deny|tool_use|provider|deny-available": "forward",
  "auto/deny|tool_use|provider|deny-unavailable": "forward",
  "full/-|tool_use|runtime|deny-available": "forward",
  "full/-|tool_use|runtime|deny-unavailable": "forward",
  "full/-|tool_use|provider|deny-available": "forward",
  "full/-|tool_use|provider|deny-unavailable": "forward",
  "full/-|command|runtime|deny-available": "forward",
  "full/-|command|runtime|deny-unavailable": "forward",
  "full/-|command|provider|deny-available": "forward",
  "full/-|command|provider|deny-unavailable": "forward",
  "full/-|file_change|runtime|deny-available": "forward",
  "full/-|file_change|runtime|deny-unavailable": "forward",
  "full/-|file_change|provider|deny-available": "forward",
  "full/-|file_change|provider|deny-unavailable": "forward",
  "full/-|permission_grant|runtime|deny-available": "forward",
  "full/-|permission_grant|runtime|deny-unavailable": "forward",
  "full/-|permission_grant|provider|deny-available": "forward",
  "full/-|permission_grant|provider|deny-unavailable": "forward",
  "full/-|plan|runtime|deny-available": "forward",
  "full/-|plan|runtime|deny-unavailable": "forward",
  "full/-|plan|provider|deny-available": "forward",
  "full/-|plan|provider|deny-unavailable": "forward",
} satisfies Record<CellKey, Outcome>;

type SameUnion<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
const policyKeyCoversPolicyUnion: SameUnion<
  PolicyKey,
  | `${Extract<RuntimePermissionPolicy, { permissionEscalation: PermissionEscalation }>["permissionMode"]}/${PermissionEscalation}`
  | `${Extract<RuntimePermissionPolicy, { permissionEscalation: null }>["permissionMode"]}/-`
> = true;
const subjectKindCoversUnion: SameUnion<
  SubjectKind,
  PendingInteractionApprovalSubject["kind"]
> = true;
const enforcerCoversUnion: SameUnion<
  Enforcer,
  BridgeProtocolAdapter["approvalEnforcedBy"]
> = true;
const permissionModeCoversUnion: SameUnion<
  PolicyKey extends `${infer Mode}/${string}` ? Mode : never,
  PermissionMode
> = true;
void policyKeyCoversPolicyUnion;
void subjectKindCoversUnion;
void enforcerCoversUnion;
void permissionModeCoversUnion;

function policyFor(key: PolicyKey): RuntimePermissionPolicy {
  switch (key) {
    case "accept-edits/ask":
    case "accept-edits/deny":
      return {
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: key === "accept-edits/ask" ? "ask" : "deny",
      };
    case "auto/ask":
    case "auto/deny":
      return {
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
        permissionEscalation: key === "auto/ask" ? "ask" : "deny",
      };
    case "full/-":
      return {
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      };
  }
}

function subjectFor(kind: SubjectKind): PendingInteractionApprovalSubject {
  switch (kind) {
    case "command":
      return {
        kind,
        itemId: "item-command",
        command: "git push",
        cwd: "/workspace",
        actions: [],
        sessionGrant: null,
      };
    case "file_change":
      return {
        kind,
        itemId: "item-file-change",
        writeScope: null,
        sessionGrant: null,
      };
    case "permission_grant":
      return {
        kind,
        itemId: "item-permission-grant",
        toolName: "WebFetch",
        permissions: { network: { enabled: true }, fileSystem: null },
      };
    case "plan":
      return {
        kind,
        itemId: "item-plan",
        plan: "1. Do the thing",
        planFilePath: null,
      };
    case "tool_use":
      return {
        kind,
        itemId: "item-tool-use",
        tool: "mcp__example__deploy",
        presentation: {
          label: { pending: "Deploying", completed: "Deployed" },
          icon: { glyph: "rocket" },
        },
      };
  }
}

function decisionsFor(
  availability: DenyAvailability,
): PendingInteractionApprovalDecision[] {
  return availability === "deny-available"
    ? ["allow_once", "allow_for_session", "deny"]
    : ["allow_once", "allow_for_session"];
}

function buildPayload(
  kind: SubjectKind,
  availability: DenyAvailability,
): ApprovalPendingInteractionPayload {
  return {
    kind: "approval",
    subject: subjectFor(kind),
    reason: null,
    availableDecisions: decisionsFor(availability),
  };
}

function adapterFor(enforcer: Enforcer): BridgeProtocolAdapter {
  const adapter = createProviderForId("fake", {
    additionalWorkspaceWriteRoots: [],
    bridgeLaunch: createScriptedEchoLaunch(),
  });
  const [initialize] = adapter.buildPostInitializeRequests();
  if (initialize === undefined) {
    throw new Error("bridge adapter exposes no initialize handshake");
  }
  initialize.onResult({
    protocolVersion: 2,
    capabilities: { grammarVersions: [3, 3], approvalEnforcedBy: enforcer },
  });
  if (adapter.approvalEnforcedBy !== enforcer) {
    throw new Error(
      `handshake did not set approvalEnforcedBy=${enforcer} (got ${adapter.approvalEnforcedBy})`,
    );
  }
  return adapter;
}

function interactionRequest(
  id: number,
  payload: ApprovalPendingInteractionPayload,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "interaction/request",
    params: {
      providerThreadId: "prov-1",
      threadId: "thread-1",
      turnId: "turn-1",
      payload,
    },
  };
}

const jsonRpcResponseSchema = z.union([
  z.object({ result: z.object({ decision: z.string() }).passthrough() }),
  z.object({ error: z.object({ message: z.string() }).passthrough() }),
]);
type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

interface CellResult {
  forwarded: number;
  response: JsonRpcResponse;
}

interface EchoChild {
  child: ChildProcess;
  nextLine(): Promise<string>;
}

function startEchoChild(): EchoChild {
  const child = spawn(process.execPath, [
    "-e",
    "process.stdin.pipe(process.stdout)",
  ]);
  if (!child.stdout) {
    throw new Error("echo child has no stdout");
  }
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      lines.push(line);
    }
  });
  return {
    child,
    nextLine: () => {
      const queued = lines.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no JSON-RPC response within 5s")),
          5_000,
        );
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
  };
}

async function runCell(
  echo: EchoChild,
  requestId: number,
  policyKey: PolicyKey,
  kind: SubjectKind,
  enforcer: Enforcer,
  availability: DenyAvailability,
): Promise<CellResult> {
  const payload = buildPayload(kind, availability);
  const onInteractiveRequest = vi.fn(async () => ({
    decision: "allow_once" as const,
    grantedPermissions: null,
  }));
  const executionOptions: AgentRuntimeExecutionOptions = {
    ...fullRuntimeOptions,
    ...policyFor(policyKey),
  };
  const rawRequest = interactionRequest(requestId, payload);
  handleRuntimeProviderRequest({
    getActiveTurnId: () => "turn-1",
    getThreadExecutionOptions: () => executionOptions,
    onInteractiveRequest,
    onToolCall: async () => ({
      contentItems: [{ type: "inputText", text: "unused" }],
      success: true,
    }),
    parsedId: requestId,
    parsedMethod: rawRequest.method,
    providerProcess: {
      adapter: adapterFor(enforcer),
      child: echo.child,
      interactiveRequestScope: `matrix-${requestId}`,
    },
    rawRequest,
    resolveThreadId: () => "thread-1",
  });
  const parsed = parseJsonRpcLine((await echo.nextLine()).trim());
  if (parsed.kind !== "response") {
    throw new Error(`expected a JSON-RPC response, got ${parsed.kind}`);
  }
  return {
    forwarded: onInteractiveRequest.mock.calls.length,
    response: jsonRpcResponseSchema.parse(parsed.parsed),
  };
}

function classify(result: CellResult): Outcome {
  const { response } = result;
  if ("error" in response) {
    if (
      response.error.message.includes(
        "cannot be auto-denied because deny is unavailable",
      )
    ) {
      return "encode-error";
    }
    throw new Error(`unexpected JSON-RPC error: ${response.error.message}`);
  }
  const { decision } = response.result;
  if (decision === "deny" && result.forwarded === 0) {
    return "auto-deny";
  }
  if (decision === "allow_once" && result.forwarded === 1) {
    return "forward";
  }
  throw new Error(
    `unclassifiable response ${JSON.stringify(response.result)} (forwarded ${result.forwarded})`,
  );
}

const CELLS = POLICY_KEYS.flatMap((policyKey) =>
  SUBJECT_KINDS.flatMap((kind) =>
    ENFORCERS.flatMap((enforcer) =>
      DENY_AVAILABILITY.map(
        (availability) => [policyKey, kind, enforcer, availability] as const,
      ),
    ),
  ),
);

describe("permission decision matrix", () => {
  it("enumerates every cell of the cross product", () => {
    for (const kind of SUBJECT_KINDS) {
      expect(
        pendingInteractionPayloadSchema.safeParse(
          buildPayload(kind, "deny-available"),
        ).success,
        `subject kind ${kind}`,
      ).toBe(true);
    }
    expect(
      bridgeCapabilitiesSchema.shape.approvalEnforcedBy.def.innerType.options,
    ).toEqual([...ENFORCERS]);
    expect(permissionEscalationValues).toEqual(["ask", "deny"]);
    expect(permissionModeValues).toEqual(["accept-edits", "auto", "full"]);
    expect(runtimePermissionPolicySchema.options).toHaveLength(3);
    expect(Object.keys(EXPECTED)).toHaveLength(
      POLICY_KEYS.length *
        SUBJECT_KINDS.length *
        ENFORCERS.length *
        DENY_AVAILABILITY.length,
    );
    expect(CELLS).toHaveLength(100);
  });

  it("pins the bridge-kit predicate: only escalation=deny auto-denies", () => {
    const escalations: (PermissionEscalation | null)[] = [
      ...permissionEscalationValues,
      null,
    ];
    expect(
      escalations.map((permissionEscalation) => [
        permissionEscalation,
        shouldAutoDenyInteractiveRequest({ permissionEscalation }),
      ]),
    ).toEqual([
      ["ask", false],
      ["deny", true],
      [null, false],
    ]);
  });

  describe("handleRuntimeProviderRequest", () => {
    let echo: EchoChild;
    let nextRequestId = 1;

    beforeAll(() => {
      echo = startEchoChild();
    });

    afterAll(() => {
      echo.child.kill();
    });

    it.each(CELLS)(
      "%s × %s × %s × %s",
      async (policyKey, kind, enforcer, availability) => {
        const key: CellKey = `${policyKey}|${kind}|${enforcer}|${availability}`;
        const result = await runCell(
          echo,
          nextRequestId++,
          policyKey,
          kind,
          enforcer,
          availability,
        );
        expect(classify(result)).toBe(EXPECTED[key]);
      },
    );
  });
});
