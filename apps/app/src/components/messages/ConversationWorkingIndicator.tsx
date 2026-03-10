import { ConversationStatusIndicator } from "@/components/messages/ConversationStatusIndicator";

interface ConversationWorkingIndicatorProps {
  isThinking?: boolean;
}

export function ConversationWorkingIndicator({
  isThinking = false,
}: ConversationWorkingIndicatorProps) {
  return (
    <div style={{ overflowAnchor: "none" }}>
      <ConversationStatusIndicator
        label={isThinking ? "Thinking..." : "Working..."}
        className="mt-4"
      />
    </div>
  );
}
