import { describeMutationErrorToast } from "@/lib/query/mutation-errors";
import { createProfileQueryClient } from "@/lib/query/query-client";
import {
  createProfileClientRegistry,
  type ProfileClientRegistry,
} from "@/lib/sdk";
import { toast } from "@/ui/Toast";

let instance: ProfileClientRegistry | null = null;

export function getAppProfileClientRegistry(): ProfileClientRegistry {
  if (!instance) {
    instance = createProfileClientRegistry({
      createQueryClient: () =>
        createProfileQueryClient({
          onMutationError: (error, mutation) => {
            const described = describeMutationErrorToast(error, mutation.meta);
            if (!described) return;
            toast.error(described.title, {
              ...(described.description
                ? { description: described.description }
                : {}),
            });
          },
        }),
    });
  }
  return instance;
}
