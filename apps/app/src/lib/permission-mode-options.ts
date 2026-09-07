import type { PermissionMode } from "@bb/domain";
import type { IconName } from "@bb/shared-ui/icon";
import {
  PERMISSION_MODE_OPTIONS as CORE_PERMISSION_MODE_OPTIONS,
  type PermissionModeOption as CorePermissionModeOption,
} from "@bb/client-core";

export interface PermissionModeOption extends CorePermissionModeOption {
  iconName: IconName;
}

const PERMISSION_MODE_ICONS: Record<PermissionMode, IconName> = {
  "accept-edits": "FolderEdit",
  auto: "SecurityCheck",
  full: "SquareUnlock02",
};

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] =
  CORE_PERMISSION_MODE_OPTIONS.map((option) => ({
    ...option,
    iconName: PERMISSION_MODE_ICONS[option.value],
  }));
