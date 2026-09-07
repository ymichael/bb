import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Screen } from "../shell/Screen";

interface GroupedScreenProps {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function GroupedScreen({
  children,
  scroll,
  contentStyle,
  testID,
}: GroupedScreenProps) {
  return (
    <Screen
      scroll={scroll}
      surface="grouped"
      contentStyle={[{ flexGrow: 1 }, contentStyle]}
      testID={testID}
    >
      {children}
    </Screen>
  );
}
