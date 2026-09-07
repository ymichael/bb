import { Alert } from "react-native";
import { haptic } from "@/lib/haptics";

export interface ConfirmDestructiveOptions {
  title: string;
  message?: string;
  actionLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function confirmDestructive({
  title,
  message,
  actionLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDestructiveOptions): void {
  haptic("warning");
  Alert.alert(
    title,
    message,
    [
      { text: cancelLabel, style: "cancel", onPress: onCancel },
      { text: actionLabel, style: "destructive", onPress: onConfirm },
    ],
    { cancelable: true, onDismiss: onCancel },
  );
}
