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

export function createThreadId(): string {
  return createId("thr");
}

export function createEventId(): string {
  return createId("evt");
}

export function createDraftId(): string {
  return createId("draft");
}

export function createHostDaemonSessionId(): string {
  return createId("hses");
}

export function createHostDaemonCommandId(): string {
  return createId("hcmd");
}
