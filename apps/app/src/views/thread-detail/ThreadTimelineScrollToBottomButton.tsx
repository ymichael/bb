import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button.js";

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
