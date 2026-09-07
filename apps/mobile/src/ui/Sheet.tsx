import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Keyboard, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withAlpha } from "@/theme/colors";
import { useTheme } from "@/theme/ThemeProvider";
import { scrimBaseColor } from "@/theme/scrim";
import { cn } from "./cn";
import { Text } from "./Text";
import { useDeferredRealization } from "./useDeferredRealization";

const IS_IOS = process.env.EXPO_OS === "ios";

export const SHEET_CORNER_RADIUS = IS_IOS ? 38 : 12;
const GRABBER_WIDTH = 36;
const GRABBER_HEIGHT = 5;
const GRABBER_ALPHA = 0.3;

export interface SheetHandle {
  present: () => void;
  dismiss: () => void;
}

export interface SheetController extends SheetHandle {
  /** @internal set by the mounted Sheet. */
  attach: (handle: SheetHandle | null) => void;
}

function createSheetController(): SheetController {
  let handle: SheetHandle | null = null;
  return {
    attach: (next) => {
      handle = next;
    },
    present: () => handle?.present(),
    dismiss: () => handle?.dismiss(),
  };
}

export function useSheet(): SheetController {
  const [controller] = useState(createSheetController);
  return controller;
}

export const SheetProvider = BottomSheetModalProvider;

export const SheetPresenceContext = createContext<{
  onPresenceChange: (open: boolean) => void;
} | null>(null);

export type SheetSurface = "raised" | "grouped";

export interface SheetProps extends Pick<
  BottomSheetModalProps,
  | "snapPoints"
  | "enableDynamicSizing"
  | "maxDynamicContentSize"
  | "onDismiss"
  | "name"
  | "stackBehavior"
  | "enableContentPanningGesture"
> {
  controller: SheetController;
  children: ReactNode;
  title?: string;
  layout?: "view" | "scroll" | "custom";
  surface?: SheetSurface;
  onOpenChange?: (open: boolean) => void;
  deferContent?: boolean;
}

export function Sheet({
  controller,
  children,
  title,
  layout = "view",
  surface = "raised",
  snapPoints,
  enableDynamicSizing,
  maxDynamicContentSize,
  onDismiss,
  onOpenChange,
  name,
  stackBehavior,
  enableContentPanningGesture,
  deferContent = true,
}: SheetProps) {
  const modalRef = useRef<BottomSheetModal>(null);
  const { tokens, mode } = useTheme();
  const scrimColor = scrimBaseColor(mode, tokens);
  const insets = useSafeAreaInsets();
  const [presented, setPresented] = useState(false);
  const realized = useDeferredRealization(presented);
  const presence = useContext(SheetPresenceContext);
  const onPresenceChange = presence?.onPresenceChange;
  useEffect(() => {
    if (!onPresenceChange) return;
    onPresenceChange(presented);
    return () => {
      if (presented) onPresenceChange(false);
    };
  }, [onPresenceChange, presented]);

  useEffect(() => {
    controller.attach({
      present: () => {
        Keyboard.dismiss();
        setPresented(true);
        modalRef.current?.present();
      },
      dismiss: () => modalRef.current?.dismiss(),
    });
    return () => controller.attach(null);
  }, [controller]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.45}
        pressBehavior="close"
        style={[props.style, { backgroundColor: scrimColor }]}
      />
    ),
    [scrimColor],
  );

  const dynamic = enableDynamicSizing ?? snapPoints === undefined;
  const surfaceColor =
    surface === "grouped" ? tokens.surfaceGrouped : tokens.surfaceRaisedSolid;
  const backgroundStyle = useMemo(
    () => ({
      backgroundColor: surfaceColor,
      borderTopLeftRadius: SHEET_CORNER_RADIUS,
      borderTopRightRadius: SHEET_CORNER_RADIUS,
      borderCurve: "continuous" as const,
    }),
    [surfaceColor],
  );
  const handleIndicatorStyle = useMemo(
    () => ({
      backgroundColor: withAlpha(tokens.foreground, GRABBER_ALPHA),
      width: GRABBER_WIDTH,
      height: GRABBER_HEIGHT,
      borderRadius: GRABBER_HEIGHT / 2,
    }),
    [tokens],
  );

  const header = title ? (
    <View
      className={cn("items-center px-4 pb-3 pt-1", !IS_IOS && "border-b")}
      style={{
        backgroundColor: surfaceColor,
        borderColor: tokens.borderHairline,
      }}
    >
      <Text variant="heading" numberOfLines={1} className="text-center">
        {title}
      </Text>
    </View>
  ) : null;

  const body = realized || !deferContent ? children : <View className="h-24" />;
  const bottomPad = { paddingBottom: Math.max(insets.bottom, 12) };

  return (
    <BottomSheetModal
      ref={modalRef}
      name={name}
      stackBehavior={stackBehavior}
      snapPoints={snapPoints}
      enableDynamicSizing={dynamic}
      maxDynamicContentSize={maxDynamicContentSize}
      enablePanDownToClose
      enableContentPanningGesture={enableContentPanningGesture}
      accessible={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={backgroundStyle}
      handleIndicatorStyle={handleIndicatorStyle}
      topInset={insets.top}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onChange={(index) => onOpenChange?.(index >= 0)}
      onDismiss={() => {
        setPresented(false);
        onDismiss?.();
      }}
    >
      {layout === "custom" ? (
        <>
          {header}
          {body}
        </>
      ) : layout === "scroll" ? (
        <BottomSheetScrollView
          contentContainerStyle={bottomPad}
          stickyHeaderIndices={header ? [0] : undefined}
          keyboardShouldPersistTaps="handled"
        >
          {header}
          {body}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={bottomPad}>
          {header}
          {body}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

export {
  BottomSheetFlatList as SheetFlatList,
  BottomSheetScrollView as SheetScrollView,
  BottomSheetTextInput as SheetTextInput,
};
