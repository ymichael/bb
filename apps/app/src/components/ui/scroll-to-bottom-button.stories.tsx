import type { ReactNode } from "react";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";

export default {
  title: "Primitives/ScrollToBottomButton",
};

export function States() {
  return (
    <div className="grid max-w-xl gap-16 p-6">
      <ScrollButtonFrame label="Visible">
        <ScrollToBottomButton visible onClick={ignoreClick} />
      </ScrollButtonFrame>
      <ScrollButtonFrame label="Streaming">
        <ScrollToBottomButton visible active onClick={ignoreClick} />
      </ScrollButtonFrame>
      <ScrollButtonFrame label="Hidden">
        <ScrollToBottomButton visible={false} onClick={ignoreClick} />
      </ScrollButtonFrame>
    </div>
  );
}

interface ScrollButtonFrameProps {
  children: ReactNode;
  label: string;
}

function ScrollButtonFrame({ children, label }: ScrollButtonFrameProps) {
  return (
    <div className="relative rounded-md border border-border bg-card p-4 text-sm">
      <p className="text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function ignoreClick(): void {}
