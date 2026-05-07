import { Search, Upload } from "lucide-react";
import { Input } from "./input";

export default {
  title: "Primitives/Input",
};

export function TextStates() {
  return (
    <div className="grid max-w-3xl gap-4 p-6 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-medium">
        Project name
        <Input placeholder="Untitled project" />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Default branch
        <Input defaultValue="main" />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Disabled
        <Input value="Managed by host policy" disabled readOnly />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Error-adjacent
        <Input
          aria-invalid="true"
          defaultValue="not a url"
          className="border-destructive focus-visible:ring-destructive"
        />
      </label>
    </div>
  );
}

export function WithInlineIcons() {
  return (
    <div className="grid max-w-md gap-4 p-6">
      <label className="grid gap-1.5 text-sm font-medium">
        Search
        <span className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter threads" />
        </span>
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        File
        <span className="relative">
          <Upload className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" type="file" />
        </span>
      </label>
    </div>
  );
}
