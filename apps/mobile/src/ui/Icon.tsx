import { HugeIcon, type IconProps } from "./HugeIcon";

export function Icon(props: IconProps) {
  return <HugeIcon {...props} />;
}

export { HugeIcon, type IconProps } from "./HugeIcon";
export { ICON_NAMES, isIconName, type IconName } from "./icon-map";
