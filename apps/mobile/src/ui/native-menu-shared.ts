import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { ActionSheetAction } from "./ActionSheet";
import type { SFSymbol } from "./sf-symbol-map";

export interface NativeMenuAction extends ActionSheetAction {
  symbol?: SFSymbol;
  items?: readonly NativeMenuAction[];
  inline?: boolean;
}

export function flattenNativeMenuActions(
  actions: readonly NativeMenuAction[],
): ActionSheetAction[] {
  const rows: ActionSheetAction[] = [];
  for (const action of actions) {
    if (action.items && action.items.length > 0) {
      rows.push(...flattenNativeMenuActions(action.items));
      continue;
    }
    rows.push(action);
  }
  return rows;
}

export interface NativeMenuProps {
  title?: string;
  actions: readonly NativeMenuAction[];
  onOpen?: () => void;
  longPress?: boolean;
  disabled?: boolean;
  children: ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}
