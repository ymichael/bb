import { CalendarDays, Filter } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./popover";
import { Separator } from "./separator";
import { Switch } from "./switch";

export default {
  title: "Primitives/Popover",
};

export function OpenFilters() {
  return (
    <div className="min-h-[22rem] p-6">
      <Popover open={true}>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <Filter />
            Filters
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <div className="grid gap-4">
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">Thread filters</h3>
              <p className="text-xs text-muted-foreground">
                Limit the timeline to actionable work.
              </p>
            </div>
            <Separator />
            <FilterRow label="Only changed files" checked />
            <FilterRow label="Hide completed tools" checked={false} />
            <FilterRow label="Show manager threads" checked />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function AnchoredForm() {
  return (
    <div className="min-h-[24rem] p-6">
      <Popover open={true}>
        <PopoverAnchor>
          <div className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <CalendarDays className="size-4 text-muted-foreground" />
            May 7, 2026
          </div>
        </PopoverAnchor>
        <PopoverTrigger asChild>
          <Button variant="outline" className="ml-3">
            Edit date
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-72">
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Start date
              <Input type="date" defaultValue="2026-05-07" />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Time zone
              <Input defaultValue="America/Los_Angeles" />
            </label>
            <Button size="sm" className="justify-self-end">
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface FilterRowProps {
  checked: boolean;
  label: string;
}

function FilterRow({ checked, label }: FilterRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} />
    </div>
  );
}
