import { BrowseArchetypeCards } from "./BrowseArchetypeCards";

export default {
  title: "plugin/Browse Archetype Cards",
};

export const Grid = () => (
  <div className="min-h-screen bg-background p-8">
    <div className="mx-auto max-w-4xl">
      <BrowseArchetypeCards onCreate={(prompt) => console.log(prompt)} />
    </div>
  </div>
);

export const Narrow = () => (
  <div className="min-h-screen bg-background p-8">
    <div className="max-w-[22rem]">
      <BrowseArchetypeCards onCreate={(prompt) => console.log(prompt)} />
    </div>
  </div>
);
