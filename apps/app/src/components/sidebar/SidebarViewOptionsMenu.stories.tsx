import { useMemo } from "react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { SidebarDisplayOptionsMenu } from "./ProjectList";
import {
  sidebarChronologicalSortAtom,
  sidebarOrganizationModeAtom,
} from "./sidebarCollapsedAtoms";

export default {
  title: "sidebar/View options menu",
};

function StateReadout() {
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const sort = useAtomValue(sidebarChronologicalSortAtom);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">organize</dt>
      <dd className="font-mono">{organizationMode}</dd>
      <dt className="text-muted-foreground">sort</dt>
      <dd className="font-mono">{sort}</dd>
    </dl>
  );
}

function InteractiveMenu() {
  const store = useMemo(() => {
    const next = createStore();
    next.set(sidebarOrganizationModeAtom, "project");
    next.set(sidebarChronologicalSortAtom, "updated");
    return next;
  }, []);

  return (
    <JotaiProvider store={store}>
      <div className="flex w-72 flex-col gap-4 rounded-md bg-sidebar p-4 text-sidebar-foreground">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Projects
          </span>
          <div className="flex items-center gap-1">
            <SidebarDisplayOptionsMenu />
          </div>
        </div>
        <StateReadout />
      </div>
    </JotaiProvider>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="interactive"
        hint="open the menu · toggle By project/Manually · pick a fixed-order sort field"
      >
        <InteractiveMenu />
      </StoryRow>
    </StoryCard>
  );
}
