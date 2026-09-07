import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { View } from "react-native";
import { sfSymbolFor } from "./sf-symbol-map";
import type { NativeMenuAction, NativeMenuProps } from "./native-menu-shared";

function toMenuAction(action: NativeMenuAction): MenuAction {
  const symbol =
    action.symbol ?? (action.icon ? sfSymbolFor(action.icon) : undefined);
  const disabled = action.disabled === true;
  return {
    id: action.key,
    title:
      disabled && action.subtitle
        ? `${action.label} — ${action.subtitle}`
        : action.label,
    ...(symbol ? { image: symbol } : {}),
    ...(action.checked === undefined
      ? {}
      : { state: action.checked ? ("on" as const) : ("off" as const) }),
    attributes: {
      destructive: action.destructive === true,
      disabled,
    },
    ...(action.items && action.items.length > 0
      ? {
          subactions: action.items.map(toMenuAction),
          displayInline: action.inline === true,
        }
      : {}),
  };
}

function findAction(
  actions: readonly NativeMenuAction[],
  key: string,
): NativeMenuAction | undefined {
  for (const action of actions) {
    if (action.key === key) return action;
    const nested = action.items ? findAction(action.items, key) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

export function NativeMenu({
  title,
  actions,
  longPress = false,
  disabled = false,
  children,
  style,
  testID,
  accessibilityLabel,
}: NativeMenuProps) {
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      style={style}
      testID={testID}
    >
      {disabled ? (
        children
      ) : (
        <MenuView
          title={title}
          actions={actions.map(toMenuAction)}
          onPressAction={({ nativeEvent }) => {
            findAction(actions, nativeEvent.event)?.onPress();
          }}
          shouldOpenOnLongPress={longPress}
        >
          {children}
        </MenuView>
      )}
    </View>
  );
}

export {
  flattenNativeMenuActions,
  type NativeMenuAction,
  type NativeMenuProps,
} from "./native-menu-shared";
