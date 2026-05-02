import { FolderOpen, Inbox } from "lucide-react";
import {
  BottomAnchoredScrollBody,
  EmptyState,
  FormError,
  PageShell,
  ScrollToBottomButton,
  SettingsSection,
} from "../../src/index.js";

export default {
  title: "Primitives/Layout",
};

const sampleRows = Array.from({ length: 8 }, (_, index) => `Event ${index + 1}`);
const noop = () => undefined;

export function PageShellStatic() {
  return (
    <div className="h-96 overflow-hidden rounded-md border border-border bg-background p-4">
      <PageShell
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-3"
        footer={<div className="rounded-md border border-border p-3">Footer</div>}
      >
        <SettingsSection title="Project">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Connected workspace</p>
            <p>Last refreshed just now</p>
          </div>
        </SettingsSection>
        <EmptyState icon={FolderOpen} message="No archived threads" />
      </PageShell>
    </div>
  );
}

export function BottomAnchoredScroll() {
  return (
    <div className="h-96 overflow-hidden rounded-md border border-border bg-background">
      <BottomAnchoredScrollBody
        maxWidthClassName="max-w-[760px]"
        contentClassName="gap-2"
        footer={
          <div className="mx-auto w-full max-w-[760px] bg-background px-4 pb-4">
            <ScrollToBottomButton visible active onClick={noop} />
            <div className="rounded-md border border-border p-3 text-sm">
              Composer
            </div>
          </div>
        }
      >
        {sampleRows.map((row) => (
          <div key={row} className="rounded-md border border-border p-3 text-sm">
            {row}
          </div>
        ))}
      </BottomAnchoredScrollBody>
    </div>
  );
}

export function FeedbackStates() {
  return (
    <div className="flex max-w-xl flex-col gap-4 p-6">
      <EmptyState icon={Inbox} message="No items match this filter" />
      <FormError message="Unable to save changes." />
      <div className="pt-20">
        <ScrollToBottomButton visible onClick={noop} />
      </div>
    </div>
  );
}
