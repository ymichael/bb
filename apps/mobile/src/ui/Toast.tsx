import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { toast as sonnerToast, Toaster as SonnerToaster } from "sonner-native";
import { resolveFont } from "@/theme/fonts";
import { useTheme } from "@/theme/ThemeProvider";
import { Icon } from "./Icon";

export type ToastId = string | number;

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  id?: ToastId;
}

function show(
  kind: "success" | "error" | "info" | "warning" | "message" | "loading",
  message: string,
  options?: ToastOptions,
): ToastId {
  const data = {
    description: options?.description,
    duration: options?.duration,
    action: options?.action,
    id: options?.id,
  };
  switch (kind) {
    case "success":
      return sonnerToast.success(message, data);
    case "error":
      return sonnerToast.error(message, data);
    case "info":
      return sonnerToast.info(message, data);
    case "warning":
      return sonnerToast.warning(message, data);
    case "loading":
      return sonnerToast.loading(message, data);
    default:
      return sonnerToast(message, data);
  }
}

export const toast = {
  message: (message: string, options?: ToastOptions) =>
    show("message", message, options),
  success: (message: string, options?: ToastOptions) =>
    show("success", message, options),
  error: (message: string, options?: ToastOptions) =>
    show("error", message, options),
  info: (message: string, options?: ToastOptions) =>
    show("info", message, options),
  warning: (message: string, options?: ToastOptions) =>
    show("warning", message, options),
  loading: (message: string, options?: ToastOptions) =>
    show("loading", message, options),
  dismiss: (id?: ToastId) => sonnerToast.dismiss(id),
};

const TOAST_RADIUS = 14;
const ICON_SIZE = 20;

export function Toaster() {
  const { tokens, mode, radii } = useTheme();
  const icons = useMemo(
    () => ({
      success: (
        <Icon name="CircleCheck" size={ICON_SIZE} color={tokens.success} />
      ),
      error: (
        <Icon name="CircleX" size={ICON_SIZE} color={tokens.destructiveText} />
      ),
      warning: (
        <Icon
          name="AlertTriangle"
          size={ICON_SIZE}
          color={tokens.warningText}
        />
      ),
      info: <Icon name="Info" size={ICON_SIZE} color={tokens.timelineAccent} />,
    }),
    [tokens],
  );
  return (
    <SonnerToaster
      theme={mode}
      position="top-center"
      swipeToDismissDirection="up"
      duration={4000}
      visibleToasts={3}
      icons={icons}
      toastOptions={{
        style: {
          backgroundColor: tokens.surfaceRaisedSolid,
          borderRadius: TOAST_RADIUS,
          borderCurve: "continuous",
          borderWidth: mode === "dark" ? 0 : StyleSheet.hairlineWidth,
          borderColor: tokens.borderHairline,
          boxShadow: `0 6px 20px ${tokens.shadowColor}`,
        },
        titleStyle: {
          ...resolveFont({ weight: "semibold" }),
          color: tokens.foreground,
          fontSize: 15,
        },
        descriptionStyle: {
          ...resolveFont({}),
          color: tokens.mutedForeground,
          fontSize: 13,
        },
        actionButtonStyle: {
          backgroundColor: tokens.primary,
          borderRadius: radii.full,
        },
        actionButtonTextStyle: {
          ...resolveFont({ weight: "semibold" }),
          color: tokens.primaryForeground,
        },
      }}
    />
  );
}
