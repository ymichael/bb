import {
  createContext,
  createRef,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export interface OverlayBoundsValue {
  ref: RefObject<View | null>;
  layoutVersion: number;
}

const DETACHED_BOUNDS: OverlayBoundsValue = {
  ref: createRef<View>(),
  layoutVersion: 0,
};

const OverlayBoundsContext = createContext<OverlayBoundsValue>(DETACHED_BOUNDS);

export interface OverlayBoundsProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function OverlayBounds({ children, style, testID }: OverlayBoundsProps) {
  const ref = useRef<View>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const handleLayout = useCallback(() => {
    setLayoutVersion((version) => version + 1);
  }, []);
  const value = useMemo<OverlayBoundsValue>(
    () => ({ ref, layoutVersion }),
    [layoutVersion],
  );
  return (
    <OverlayBoundsContext.Provider value={value}>
      <View
        ref={ref}
        collapsable={false}
        style={style}
        onLayout={handleLayout}
        testID={testID}
      >
        {children}
      </View>
    </OverlayBoundsContext.Provider>
  );
}

export function useOverlayBounds(): OverlayBoundsValue {
  return useContext(OverlayBoundsContext);
}
