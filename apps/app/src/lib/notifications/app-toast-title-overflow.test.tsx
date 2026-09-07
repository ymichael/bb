// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppToastContent } from "@/components/ui/app-toast";
import {
  getNotificationCenterState,
  resetNotificationStore,
} from "./notification-store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNotificationStore();
});

it("opens the recorded notification when a title-only toast is truncated", () => {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);

  render(
    <AppToastContent
      title="The requested operation cannot continue while the workspace is occupied"
      tone="error"
      notificationId="notification-7"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Show more" }));

  expect(getNotificationCenterState()).toEqual({
    open: true,
    focusedId: "notification-7",
  });
});
