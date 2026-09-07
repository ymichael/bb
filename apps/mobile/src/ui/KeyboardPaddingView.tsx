import { useEffect, useState, type ReactNode } from "react";
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  useWindowDimensions,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const COMPOSER_KEYBOARD_GAP = 8;

export interface KeyboardPaddingViewProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  keyboardGap?: number;
  testID?: string;
}

export function KeyboardPaddingView({
  children,
  style,
  keyboardGap = 0,
  testID,
}: KeyboardPaddingViewProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bottomInset = insets.bottom;
  const [paddingBottom, setPaddingBottom] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const apply = (event: KeyboardEvent, keyboardScreenY: number) => {
      const keyboardHeight = Math.max(0, windowHeight - keyboardScreenY);
      const next =
        keyboardHeight > 0
          ? Math.max(0, keyboardHeight - bottomInset + keyboardGap)
          : 0;
      if (event.duration > 0) {
        LayoutAnimation.configureNext({
          duration: event.duration,
          update: {
            type: LayoutAnimation.Types[event.easing] ?? "keyboard",
          },
        });
      }
      setPaddingBottom(next);
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillChangeFrame", (event) =>
        apply(event, event.endCoordinates.screenY),
      ),
      Keyboard.addListener("keyboardWillHide", (event) =>
        apply(event, windowHeight),
      ),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [bottomInset, keyboardGap, windowHeight]);

  return (
    <View style={[style, { paddingBottom }]} testID={testID}>
      {children}
    </View>
  );
}
