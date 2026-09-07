import {
  usePluginSlots,
  type PluginSettingsSectionSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";

export function PluginSettingsSections({ pluginId }: { pluginId: string }) {
  const { settingsSections } = usePluginSlots();
  const sections = settingsSections.filter(
    (section) => section.pluginId === pluginId,
  );
  if (sections.length === 0) return null;
  return <PluginSettingsSectionList sections={sections} />;
}

function PluginSettingsSectionList({
  sections,
}: {
  sections: readonly PluginSettingsSectionSlot[];
}) {
  return (
    <div className="space-y-6" data-testid="plugin-settings-sections">
      {sections.map((section) => {
        const key = `${section.pluginId}/${section.id}/${section.generation}`;
        return (
          <div key={key} className="space-y-3">
            {section.title === undefined ? null : (
              <h3 className="text-xs font-medium text-foreground">
                {section.title}
              </h3>
            )}
            {section.description === undefined ? null : (
              <p className="text-xs leading-snug text-subtle-foreground/75">
                {section.description}
              </p>
            )}
            <PluginSlotMount
              pluginId={section.pluginId}
              slotKind="settingsSection"
              slotId={section.id}
            >
              <section.component />
            </PluginSlotMount>
          </div>
        );
      })}
    </div>
  );
}
