
import type { DesktopOnboardingEntrypoint } from "./DesktopOnboardingEntrypoint.js";

export type AccountLoginCompletedNotification = { loginId: string | null, success: boolean, error: string | null, onboardingEntrypoint: DesktopOnboardingEntrypoint | null, };
