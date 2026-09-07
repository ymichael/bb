import { Pressable } from "react-native";
import { ActionSheet } from "./ActionSheet";
import {
  flattenNativeMenuActions,
  type NativeMenuProps,
} from "./native-menu-shared";
import { useSheet } from "./Sheet";

export function NativeMenu({
  title,
  actions,
  onOpen,
  longPress = false,
  disabled = false,
  children,
  style,
  testID,
  accessibilityLabel,
}: NativeMenuProps) {
  const sheet = useSheet();
  const open = () => {
    onOpen?.();
    sheet.present();
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={longPress ? undefined : open}
        onLongPress={longPress ? open : undefined}
        style={style}
        testID={testID}
      >
        {children}
      </Pressable>
      <ActionSheet
        controller={sheet}
        title={title}
        actions={flattenNativeMenuActions(actions)}
      />
    </>
  );
}

export {
  flattenNativeMenuActions,
  type NativeMenuAction,
  type NativeMenuProps,
} from "./native-menu-shared";
