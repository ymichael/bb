import { useAtomValue } from "jotai";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import { threadTimelineShowScrollToBottomAtom } from "./threadTimelineAtoms";

export function ThreadTimelineScrollToBottomButton({
  onClick,
}: {
  onClick: () => void;
}) {
  const visible = useAtomValue(threadTimelineShowScrollToBottomAtom);
  return <ScrollToBottomButton visible={visible} onClick={onClick} />;
}
