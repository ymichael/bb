import { type MouseEvent as ReactMouseEvent } from "react";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  SectionSidebar,
  SectionSidebarIcon,
  SectionSidebarLabel,
  SectionSidebarActionRow,
  SectionSidebarRow,
} from "@/components/sidebar/SectionSidebar";
import { canOpenNativeScreen, shellOpenNative } from "@/lib/native-shell";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { useSettingsNavState } from "./settings-nav";
import type { SettingsNavState } from "./settings-nav";
import { getSettingsSectionRoutePath } from "./settings-sections";

interface SettingsSidebarProps {
  onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  isResizing: boolean;
  showTopReserve: boolean;
  appRoutePath: string;
  mobileHosted?: boolean;
}

type SettingsSidebarNavigation = Pick<
  SettingsNavState,
  "activePluginId" | "activeSection" | "pluginEntries" | "sections"
>;

interface SettingsSidebarContentProps extends SettingsSidebarProps {
  navigation: SettingsSidebarNavigation;
  testIdPrefix?: string;
}

export function SettingsSidebarContent({
  onResizeMouseDown,
  isResizing,
  showTopReserve,
  appRoutePath,
  mobileHosted,
  navigation,
  testIdPrefix = "settings",
}: SettingsSidebarContentProps) {
  const { activePluginId, activeSection, pluginEntries, sections } = navigation;
  const hasPlugins = pluginEntries.length > 0;

  return (
    <SectionSidebar
      backLabel="Back to app"
      backTo={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      onResizeMouseDown={onResizeMouseDown}
      showTopReserve={showTopReserve}
      testIdPrefix={testIdPrefix}
    >
      <SectionSidebarLabel>Settings</SectionSidebarLabel>
      <div className="mt-1 space-y-0.5">
        {sections
          .filter((section) => section.id !== "archived")
          .map((section) => (
            <SectionSidebarRow
              key={section.id}
              active={activeSection === section.id}
              label={section.label}
              to={getSettingsSectionRoutePath(section.id)}
            >
              <SectionSidebarIcon name={section.icon} />
            </SectionSidebarRow>
          ))}
      </div>
      {hasPlugins ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Plugins</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {pluginEntries.map((entry) => (
              <SectionSidebarRow
                key={entry.id}
                active={activePluginId === entry.id}
                label={entry.label}
                to={getPluginConfigurationRoutePath({ pluginId: entry.id })}
              >
                <PluginIcon
                  pluginId={entry.id}
                  icon={entry.icon}
                  className="size-4 shrink-0"
                />
              </SectionSidebarRow>
            ))}
          </div>
        </>
      ) : null}
      {canOpenNativeScreen() ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>This phone</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            <SectionSidebarActionRow
              label="This device"
              testId="settings-nav-native-device"
              onClick={() => shellOpenNative("device-settings")}
            >
              <SectionSidebarIcon name="Smartphone" />
            </SectionSidebarActionRow>
          </div>
        </>
      ) : null}
      {sections.some((section) => section.id === "archived") ? (
        <>
          <div className="mt-4">
            <SectionSidebarLabel>Archived</SectionSidebarLabel>
          </div>
          <div className="mt-1 space-y-0.5">
            {sections
              .filter((section) => section.id === "archived")
              .map((section) => (
                <SectionSidebarRow
                  key={section.id}
                  active={activeSection === section.id}
                  label={section.label}
                  to={getSettingsSectionRoutePath(section.id)}
                >
                  <SectionSidebarIcon name={section.icon} />
                </SectionSidebarRow>
              ))}
          </div>
        </>
      ) : null}
    </SectionSidebar>
  );
}

export function SettingsSidebar({
  onResizeMouseDown,
  isResizing,
  showTopReserve,
  appRoutePath,
  mobileHosted,
}: SettingsSidebarProps) {
  const navigation = useSettingsNavState();

  return (
    <SettingsSidebarContent
      appRoutePath={appRoutePath}
      isResizing={isResizing}
      mobileHosted={mobileHosted}
      navigation={navigation}
      onResizeMouseDown={onResizeMouseDown}
      showTopReserve={showTopReserve}
    />
  );
}
