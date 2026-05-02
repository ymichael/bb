import { useBottomAnchoredScroll } from "@bb/ui-core";
import { ScrollToBottomButton } from "@bb/ui-core";

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
