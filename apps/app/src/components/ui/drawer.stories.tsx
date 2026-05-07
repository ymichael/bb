import { SlidersHorizontal } from "lucide-react";
import { Button } from "./button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";
import { Switch } from "./switch";

export default {
  title: "Primitives/Drawer",
};

export function OpenDrawer() {
  return (
    <div className="min-h-[26rem] p-6">
      <Drawer open={true}>
        <DrawerTrigger asChild>
          <Button variant="outline">
            <SlidersHorizontal />
            Runtime options
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <div className="mx-auto grid w-full max-w-lg gap-5 px-4 pb-6 pt-3">
            <div className="grid gap-1.5">
              <DrawerTitle>Runtime options</DrawerTitle>
              <DrawerDescription>
                Tune local execution defaults before starting the next thread.
              </DrawerDescription>
            </div>
            <div className="grid gap-3">
              <DrawerSetting label="Auto-approve reads" checked />
              <DrawerSetting label="Use isolated worktree" checked />
              <DrawerSetting label="Start dev server" checked={false} />
            </div>
            <div className="flex justify-end gap-2">
              <DrawerClose asChild>
                <Button variant="outline">Cancel</Button>
              </DrawerClose>
              <Button>Apply</Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

export function ShortContent() {
  return (
    <div className="min-h-[18rem] p-6">
      <Drawer open={true}>
        <DrawerContent className="max-h-none">
          <div className="mx-auto grid w-full max-w-sm gap-3 px-4 pb-5 pt-2">
            <DrawerTitle>Connection restored</DrawerTitle>
            <DrawerDescription>
              The host daemon is accepting commands again.
            </DrawerDescription>
            <DrawerClose asChild>
              <Button className="justify-self-end">Done</Button>
            </DrawerClose>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

interface DrawerSettingProps {
  checked: boolean;
  label: string;
}

function DrawerSetting({ checked, label }: DrawerSettingProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} />
    </div>
  );
}
