import {
  usePluginSlots,
  type PluginHomepageSectionSlot,
} from "@/lib/plugin-slots";
import { useRouteState } from "@/hooks/useRouteState";
import { getPluginHomepageSectionAnchor } from "@/lib/plugin-homepage-section";
import { PluginSlotMount } from "./PluginSlotMount";

export function PluginHomepageSections() {
  const { homepageSections } = usePluginSlots();
  if (homepageSections.length === 0) return null;
  return <PluginHomepageSectionList sections={homepageSections} />;
}

function PluginHomepageSectionList({
  sections,
}: {
  sections: readonly PluginHomepageSectionSlot[];
}) {
  const { projectId } = useRouteState();
  return (
    <div className="mt-6 space-y-6" data-testid="plugin-homepage-sections">
      {sections.map((section) => (
        <section
          key={`${section.pluginId}/${section.id}/${section.generation}`}
          id={getPluginHomepageSectionAnchor(section.pluginId, section.id)}
          className="space-y-3"
        >
          <h2 className="text-sm font-semibold text-foreground">
            {section.title}
          </h2>
          <PluginSlotMount
            pluginId={section.pluginId}
            slotKind="homepageSection"
            slotId={section.id}
          >
            <section.component projectId={projectId ?? null} />
          </PluginSlotMount>
        </section>
      ))}
    </div>
  );
}
