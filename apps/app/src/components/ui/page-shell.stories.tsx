import { FolderOpen, Inbox } from "lucide-react";
import { EmptyState } from "./empty-state";
import { PageShell } from "./page-shell";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import { SettingsSection } from "./settings-section";

export default {
  title: "Primitives/PageShell",
};

const activityRows = Array.from(
  { length: 9 },
  (_, index) => `Thread activity ${index + 1}`,
);

export function StaticWithFooter() {
  return (
    <div className="h-[28rem] overflow-hidden rounded-md border border-border bg-background p-4">
      <PageShell
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="gap-3"
        footer={
          <div className="rounded-md border border-border bg-card p-3 text-sm">
            Footer
          </div>
        }
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

export function BottomAnchor() {
  return (
    <div className="h-[28rem] overflow-hidden rounded-md border border-border bg-background p-4">
      <PageShell
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        scrollBehavior="bottom-anchor"
        contentClassName="gap-2"
        footer={
          <div className="rounded-md border border-border bg-card p-3 text-sm">
            Streaming composer
          </div>
        }
      >
        {activityRows.map((row) => (
          <div
            key={row}
            className="rounded-md border border-border bg-card p-3 text-sm"
          >
            {row}
          </div>
        ))}
      </PageShell>
    </div>
  );
}

export function EmptyContent() {
  return (
    <div className="h-80 overflow-hidden rounded-md border border-border bg-background p-4">
      <PageShell
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        contentClassName="flex-1 justify-center"
      >
        <EmptyState
          icon={Inbox}
          message="No thread activity yet"
          className="justify-center"
        />
      </PageShell>
    </div>
  );
}

export function CustomFooterWidth() {
  return (
    <div className="h-80 overflow-hidden rounded-md border border-border bg-background p-4">
      <PageShell
        shellClassName="!mx-0 !mt-0 md:!mx-0 md:!mt-0"
        maxWidthClassName="max-w-md"
        contentClassName="gap-3"
        footerClassName="pb-6"
        footer={
          <div>
            <ScrollToBottomButton visible onClick={ignoreClick} />
            <div className="rounded-md border border-border bg-card p-3 text-sm">
              Narrow footer
            </div>
          </div>
        }
      >
        <SettingsSection title="Workspace">
          <p className="text-sm text-muted-foreground">
            Local environment selected.
          </p>
        </SettingsSection>
      </PageShell>
    </div>
  );
}

function ignoreClick(): void {}
