import { customAlphabet } from "nanoid";

const PRETTY_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const PRETTY_ID_SUFFIX_LENGTH = 10;

const generatePrettyIdSuffix = customAlphabet(
  PRETTY_ID_ALPHABET,
  PRETTY_ID_SUFFIX_LENGTH,
);

function createId(prefix: string): string {
  return `${prefix}_${generatePrettyIdSuffix()}`;
}

export function createHostId(): string {
  return createId("host");
}

export function createProjectId(): string {
  return createId("proj");
}

export function createProjectSourceId(): string {
  return createId("src");
}

export function createEnvironmentId(): string {
  return createId("env");
}

export function createEnvironmentOperationId(): string {
  return createId("eop");
}

export function createEnvironmentProvisioningId(): string {
  return createId("epv");
}

export function createHostOperationId(): string {
  return createId("hop");
}

export function createThreadId(): string {
  return createId("thr");
}

export function createThreadOperationId(): string {
  return createId("top");
}

export function createThreadProvisioningId(): string {
  return createId("tpv");
}

export function createAutomationId(): string {
  return createId("auto");
}

export function createProjectOperationId(): string {
  return createId("pop");
}

export function createManagerThreadNudgeId(): string {
  return createId("mnge");
}

export function createEventId(): string {
  return createId("evt");
}

export function createDraftId(): string {
  return createId("draft");
}

export function createDraftClaimToken(): string {
  return createId("dclaim");
}

export function createPendingInteractionId(): string {
  return createId("pint");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}

export function createHostDaemonCommandId(): string {
  return createId("hcmd");
}

export function createSandboxProviderCredentialId(): string {
  return createId("pcred");
}

export function createCloudAuthAttemptId(): string {
  return createId("authatt");
}
