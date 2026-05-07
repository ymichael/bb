import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import { BottomAnchoredScrollBody } from "./bottom-anchored-scroll-body";

export default {
  title: "Primitives/BottomAnchoredScrollBody",
};

const rows = Array.from(
  { length: 14 },
  (_, index) => `Streaming event ${index + 1}`,
);

export function WithStickyComposer() {
  return (
    <div className="h-[28rem] overflow-hidden rounded-md border border-border bg-background">
      <BottomAnchoredScrollBody
        maxWidthClassName="max-w-[760px]"
        contentClassName="gap-2"
        footer={
          <div className="mx-auto w-full max-w-[760px] bg-background px-4 pb-4">
            <ScrollToBottomButton
              visible
              active
              onClick={ignoreClick}
              ariaLabel="Scroll to latest streaming event"
            />
            <div className="rounded-md border border-border bg-card p-3 text-sm">
              Composer
            </div>
          </div>
        }
      >
        {rows.map((row) => (
          <div
            key={row}
            className="rounded-md border border-border bg-card p-3 text-sm"
          >
            {row}
          </div>
        ))}
      </BottomAnchoredScrollBody>
    </div>
  );
}

export function NarrowContent() {
  return (
    <div className="h-80 overflow-hidden rounded-md border border-border bg-background">
      <BottomAnchoredScrollBody
        maxWidthClassName="max-w-md"
        contentClassName="gap-3"
        footer={
          <div className="mx-auto w-full max-w-md bg-background px-4 pb-4">
            <div className="rounded-md border border-border bg-card p-3 text-sm">
              Compact footer
            </div>
          </div>
        }
      >
        {rows.slice(0, 6).map((row) => (
          <div
            key={row}
            className="rounded-md border border-border bg-card p-3 text-sm"
          >
            {row}
          </div>
        ))}
      </BottomAnchoredScrollBody>
    </div>
  );
}

function ignoreClick(): void {}
