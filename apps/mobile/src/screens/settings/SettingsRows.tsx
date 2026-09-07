import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useTheme } from "@/theme";
import {
  GroupedRow,
  GroupedSection,
  Icon,
  Spinner,
  Switch,
  Text,
  type GroupedRowProps,
  type GroupedSectionProps,
  type IconName,
} from "@/ui";

const IS_IOS = process.env.EXPO_OS === "ios";

export interface SettingsSectionProps {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  footnote?: string | ReactNode;
  separatorInset?: GroupedSectionProps["separatorInset"];
  className?: string;
  testID?: string;
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  footnote,
  separatorInset,
  className,
  testID,
}: SettingsSectionProps) {
  return (
    <GroupedSection
      title={title}
      description={description}
      action={action}
      footer={footnote}
      separatorInset={separatorInset}
      className={className}
      testID={testID}
    >
      {children}
    </GroupedSection>
  );
}

export interface SettingsControlRowProps {
  label: string;
  description?: string;
  tag?: string;
  control?: ReactNode;
  leading?: GroupedRowProps["leading"];
  badge?: GroupedRowProps["badge"];
  onPress?: () => void;
  disabled?: boolean;
  titleLines?: number;
  testID?: string;
  accessibilityLabel?: string;
}

export function SettingsControlRow({
  label,
  description,
  tag,
  control,
  leading,
  badge,
  onPress,
  disabled = false,
  titleLines = 2,
  testID,
  accessibilityLabel,
}: SettingsControlRowProps) {
  return (
    <GroupedRow
      title={label}
      subtitle={description}
      value={tag}
      leading={leading}
      badge={badge}
      trailing={control}
      onPress={onPress}
      disabled={disabled}
      titleLines={titleLines}
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? label}
    />
  );
}

export interface SettingsSwitchRowProps {
  label: string;
  description?: string;
  tag?: string;
  leading?: GroupedRowProps["leading"];
  badge?: GroupedRowProps["badge"];
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  testID?: string;
}

export function SettingsSwitchRow({
  label,
  description,
  tag,
  leading,
  badge,
  checked,
  onCheckedChange,
  disabled = false,
  pending = false,
  testID,
}: SettingsSwitchRowProps) {
  const { tokens } = useTheme();
  return (
    <SettingsControlRow
      label={label}
      description={description}
      tag={tag}
      leading={leading}
      badge={badge}
      control={
        <View className="flex-row items-center gap-2">
          {pending ? (
            <Spinner size="small" color={tokens.mutedForeground} />
          ) : null}
          <Switch
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled}
            accessibilityLabel={label}
            testID={testID}
          />
        </View>
      }
    />
  );
}

export interface SettingsValueRowProps {
  label: string;
  value: string;
  description?: string;
  leading?: GroupedRowProps["leading"];
  badge?: GroupedRowProps["badge"];
  onPress?: () => void;
  disabled?: boolean;
  tone?: "default" | "warning" | "destructive";
  selectable?: boolean;
  testID?: string;
}

export function SettingsValueRow({
  label,
  value,
  description,
  leading,
  badge,
  onPress,
  disabled,
  tone = "default",
  selectable = false,
  testID,
}: SettingsValueRowProps) {
  return (
    <GroupedRow
      title={label}
      subtitle={description}
      value={value}
      valueTone={tone}
      leading={leading}
      badge={badge}
      trailing={onPress ? "chevron" : undefined}
      onPress={onPress}
      disabled={disabled}
      selectable={selectable}
      testID={testID}
    />
  );
}

export function SettingsHint({
  title,
  message,
  testID,
}: {
  title: string;
  message: string;
  testID?: string;
}) {
  return (
    <View className="gap-0.5 px-4 py-3" testID={testID}>
      <Text variant="bodyLarge">{title}</Text>
      <Text variant="caption">{message}</Text>
    </View>
  );
}

export const ICON_ROW_SEPARATOR_INSET = 16 + 20 + 12;

export interface HeaderIconButtonProps {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}

export function HeaderIconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  loading = false,
  testID,
}: HeaderIconButtonProps) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={8}
      disabled={disabled || loading}
      onPress={onPress}
      className={disabled ? "opacity-50" : undefined}
      testID={testID}
    >
      {loading ? (
        <Spinner size="small" color={tokens.mutedForeground} />
      ) : (
        <Icon
          name={icon}
          size={22}
          color={IS_IOS ? tokens.primary : tokens.foreground}
        />
      )}
    </Pressable>
  );
}
