// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentsSettingsSection } from "./SettingsView";

afterEach(cleanup);

function renderSection(overrides?: {
  onChangelogPreviewEnabledChange?: (enabled: boolean) => void;
  onMobileAppEnabledChange?: (enabled: boolean) => void;
  onSidebarProgressiveDisclosureEnabledChange?: (enabled: boolean) => void;
  onTimelineWindowingEnabledChange?: (enabled: boolean) => void;
}) {
  return render(
    <ExperimentsSettingsSection
      changelogPreviewEnabled={false}
      disabled={false}
      editMessagesEnabled={false}
      mobileAppEnabled={false}
      sidebarProgressiveDisclosureEnabled={false}
      timelineWindowingEnabled={false}
      onChangelogPreviewEnabledChange={
        overrides?.onChangelogPreviewEnabledChange ?? vi.fn()
      }
      onEditMessagesEnabledChange={vi.fn()}
      onMobileAppEnabledChange={overrides?.onMobileAppEnabledChange ?? vi.fn()}
      onSidebarProgressiveDisclosureEnabledChange={
        overrides?.onSidebarProgressiveDisclosureEnabledChange ?? vi.fn()
      }
      onTimelineWindowingEnabledChange={
        overrides?.onTimelineWindowingEnabledChange ?? vi.fn()
      }
    />,
  );
}

describe("ExperimentsSettingsSection", () => {
  it("reports changelog preview changes", () => {
    const onChange = vi.fn();
    renderSection({ onChangelogPreviewEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("Changelog preview"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports mobile app changes", () => {
    const onChange = vi.fn();
    renderSection({ onMobileAppEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("Mobile app"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports sidebar progressive disclosure changes", () => {
    const onChange = vi.fn();
    renderSection({ onSidebarProgressiveDisclosureEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("Sidebar progressive disclosure"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reports timeline windowing changes", () => {
    const onChange = vi.fn();
    renderSection({ onTimelineWindowingEnabledChange: onChange });
    fireEvent.click(screen.getByLabelText("Timeline windowing"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
