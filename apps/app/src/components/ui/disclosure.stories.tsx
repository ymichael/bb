import { useState } from "react";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  CollapsibleHeader,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
} from "./disclosure";
import { StatusPill } from "./status-pill";

export default {
  title: "Primitives/Disclosure",
};

export function Headers() {
  return (
    <div className="grid max-w-xl gap-3 p-6">
      <CollapsibleHeader
        summaryContent="Collapsed thread details"
        toneClassName={getCollapsibleHeaderToneClass(false)}
        isExpanded={false}
        onToggle={ignoreToggle}
      />
      <CollapsibleHeader
        summaryContent="Expanded thread details"
        toneClassName={getCollapsibleHeaderToneClass(true)}
        isExpanded
        onToggle={ignoreToggle}
      />
      <CollapsibleHeader
        summaryContent="Static summary"
        toneClassName={COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}
      />
    </div>
  );
}

export function Panels() {
  return (
    <div className="grid max-w-xl gap-3 p-6">
      <ExpandablePanel
        isExpanded
        summaryContent={<PanelSummary label="Expanded panel" />}
        headerToneClass={getCollapsibleHeaderToneClass(true)}
        onToggle={ignoreToggle}
        className="border border-border bg-card"
      >
        <PanelBody />
      </ExpandablePanel>
      <ExpandablePanel
        isExpanded={false}
        summaryContent={<PanelSummary label="Collapsed panel" />}
        headerToneClass={getCollapsibleHeaderToneClass(false)}
        onToggle={ignoreToggle}
        className="border border-border bg-card"
      >
        <PanelBody />
      </ExpandablePanel>
    </div>
  );
}

export function InteractivePanel() {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="max-w-xl p-6">
      <ExpandablePanel
        isExpanded={isExpanded}
        summaryContent={<PanelSummary label="Agent activity" />}
        headerToneClass={getCollapsibleHeaderToneClass(isExpanded)}
        onToggle={() => setIsExpanded((current) => !current)}
        className="border border-border bg-card"
      >
        <PanelBody />
      </ExpandablePanel>
    </div>
  );
}

interface PanelSummaryProps {
  label: string;
}

function PanelSummary({ label }: PanelSummaryProps) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate">{label}</span>
      <StatusPill variant="secondary">3 events</StatusPill>
    </span>
  );
}

function PanelBody() {
  return (
    <div className="grid gap-2 text-sm text-foreground">
      <div className="rounded-md border border-border bg-background p-2">
        Read package metadata
      </div>
      <div className="rounded-md border border-border bg-background p-2">
        Added story fixtures
      </div>
    </div>
  );
}

function ignoreToggle(): void {}
