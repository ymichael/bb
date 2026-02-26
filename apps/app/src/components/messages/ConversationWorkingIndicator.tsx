interface ConversationWorkingIndicatorProps {
  isThinking?: boolean
}

export function ConversationWorkingIndicator({
  isThinking = false,
}: ConversationWorkingIndicatorProps) {
  return (
    <div className="mt-4 px-2 text-sm text-muted-foreground" style={{ overflowAnchor: "none" }}>
      <span className="animate-shine">{isThinking ? "Thinking..." : "Working..."}</span>
    </div>
  )
}
