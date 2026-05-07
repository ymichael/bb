import {
  ConversationStatusIndicator,
  ConversationWorkingIndicator,
  ThreadContextWindowIndicator,
} from "./index";

export default {
  title: "Thread Timeline/Indicators",
};

export function StatusAndWorking() {
  return (
    <div className="flex max-w-2xl flex-col gap-4 p-6">
      <ConversationStatusIndicator label="Loading thread..." />
      <ConversationWorkingIndicator label="Working..." />
      <ConversationWorkingIndicator
        label="Thinking..."
        isThinking
        details="Reviewing recent messages and deciding what to do next."
      />
    </div>
  );
}

export function ContextWindow() {
  return (
    <div className="flex items-center gap-4 p-6">
      <ThreadContextWindowIndicator
        usage={{
          usedTokens: 32_000,
          modelContextWindow: 128_000,
          estimated: false,
        }}
      />
      <ThreadContextWindowIndicator
        usage={{
          usedTokens: 118_000,
          modelContextWindow: 128_000,
          estimated: true,
        }}
      />
    </div>
  );
}
