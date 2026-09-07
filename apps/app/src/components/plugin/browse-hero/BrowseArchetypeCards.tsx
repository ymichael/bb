import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { ShowcaseExampleCard } from "@/components/showcase-hero/ShowcaseArchetypeCards";
import {
  BROWSE_ARCHETYPES,
  UTILITY_EXAMPLES,
  archetypePrompt,
  utilityPrompt,
} from "./browse-hero-archetypes";

export function BrowseArchetypeCards({
  onCreate,
  className,
}: {
  onCreate: (prompt: string) => void;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <section className={className}>
        <h3 className="text-xs font-medium text-subtle-foreground">
          Start from an example
        </h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {BROWSE_ARCHETYPES.map((archetype) => (
            <ShowcaseExampleCard
              key={archetype.id}
              icon={archetype.icon}
              title={archetype.title}
              description={archetype.hook}
              accentToken={archetype.accentToken}
              onClick={() => onCreate(archetypePrompt(archetype))}
            />
          ))}
        </div>
        <h4 className="mt-5 text-2xs font-medium text-subtle-foreground">
          Explore plugin capabilities
        </h4>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {UTILITY_EXAMPLES.map((example) => (
            <ShowcaseExampleCard
              key={example.id}
              icon={example.icon}
              title={example.label}
              description={example.brief}
              tooltip={utilityPrompt(example)}
              onClick={() => onCreate(utilityPrompt(example))}
            />
          ))}
        </div>
      </section>
    </TooltipProvider>
  );
}
