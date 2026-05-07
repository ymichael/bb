import { useBottomAnchoredScroll } from "@/components/ui";
import { ScrollToBottomButton } from "@/components/ui";

export function ThreadTimelineScrollToBottomButton({
  active,
}: {
  active: boolean;
}) {
  const bottomAnchor = useBottomAnchoredScroll();
  if (!bottomAnchor) return null;

  return (
    <ScrollToBottomButton
      visible={!bottomAnchor.isAtBottom}
      active={active}
      onClick={bottomAnchor.scrollToBottom}
    />
  );
}
