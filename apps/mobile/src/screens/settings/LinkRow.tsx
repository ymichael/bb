import { useRouter, type Href } from "expo-router";
import { GroupedRow, type GroupedRowProps } from "@/ui";

export interface LinkRowProps extends Omit<GroupedRowProps, "onPress"> {
  href: Href;
}

export function LinkRow({ href, trailing = "chevron", ...row }: LinkRowProps) {
  const router = useRouter();
  return (
    <GroupedRow
      {...row}
      trailing={trailing}
      onPress={() => router.push(href)}
    />
  );
}
