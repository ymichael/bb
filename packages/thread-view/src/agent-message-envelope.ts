const AGENT_MESSAGE_ENVELOPE_PATTERN =
  /^\[bb message from thread:([^;\]\s]+)(?:;[^\]]*)?\]\s*/;

export interface AgentMessageEnvelope {
  bodyStart: number;
  senderThreadId: string;
}

export function parseAgentMessageEnvelope(
  text: string,
): AgentMessageEnvelope | null {
  const match = AGENT_MESSAGE_ENVELOPE_PATTERN.exec(text);
  const senderThreadId = match?.[1];
  if (!match || !senderThreadId) return null;
  return {
    bodyStart: match[0].length,
    senderThreadId,
  };
}
