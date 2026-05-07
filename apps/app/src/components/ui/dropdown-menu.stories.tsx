import {
  Archive,
  Bell,
  CheckCircle2,
  Copy,
  Ellipsis,
  FolderOpen,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export default {
  title: "Primitives/DropdownMenu",
};

export function ActionMenu() {
  return (
    <div className="min-h-[20rem] p-6">
      <DropdownMenu open={true}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Thread actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Thread actions</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <FolderOpen />
              Open workspace
              <DropdownMenuShortcut>O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy />
              Copy thread ID
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <Archive />
              Archive
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive">
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SelectionStates() {
  return (
    <div className="min-h-[22rem] p-6">
      <DropdownMenu open={true}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <Ellipsis />
            View options
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked>
            <Bell />
            Desktop alerts
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={false}>
            <CheckCircle2 />
            Completed threads
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuRadioGroup value="comfortable">
            <DropdownMenuRadioItem value="compact">
              Compact
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="comfortable">
              Comfortable
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="spacious">
              Spacious
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function WithSubmenu() {
  return (
    <div className="min-h-[22rem] p-6">
      <DropdownMenu open={true}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">More actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuSub open={true}>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuItem>Active</DropdownMenuItem>
              <DropdownMenuItem>Archived</DropdownMenuItem>
              <DropdownMenuItem>Templates</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Export</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
