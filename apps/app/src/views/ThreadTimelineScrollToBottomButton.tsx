import { useBottomAnchoredScroll } from "@/components/layout/BottomAnchoredScrollBody";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";

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
