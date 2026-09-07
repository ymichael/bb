import { BROWSE_ARCHETYPES } from "./browse-hero-archetypes";
import { BrowseHeroCarousel } from "./BrowseHeroCarousel";

export default {
  title: "plugin/Browse Hero",
};

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">{children}</div>
    </div>
  );
}

export const Autoplaying = () => (
  <Stage>
    <BrowseHeroCarousel composerDisabled />
  </Stage>
);

export const EveryArchetype = () => (
  <Stage>
    <div className="space-y-10">
      {BROWSE_ARCHETYPES.map((archetype, index) => (
        <div key={archetype.id}>
          <p className="mb-2 text-xs font-medium text-subtle-foreground">
            {index + 1}. {archetype.title} — {archetype.capability}
          </p>
          <BrowseHeroCarousel
            initialIndex={index}
            autoplay={false}
            composerDisabled
          />
        </div>
      ))}
    </div>
  </Stage>
);

const slide = (index: number) => () => (
  <Stage>
    <BrowseHeroCarousel
      initialIndex={index}
      autoplay={false}
      composerDisabled
    />
  </Stage>
);

export const KanbanBoard = slide(0);
export const LiveDashboard = slide(1);
export const ChiefOfStaff = slide(2);
export const VideoEditor = slide(3);
export const PrototypingLab = slide(4);
export const SupportInbox = slide(5);
