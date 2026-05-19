import { z } from "zod";

const RESERVED_DIRECTORY_NAMES = new Set([".", ".."]);

export const managerTemplateNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "Manager template name must be a single directory name",
  })
  .refine((value) => !RESERVED_DIRECTORY_NAMES.has(value), {
    message: "Manager template name cannot be . or ..",
  });

export type ManagerTemplateName = z.infer<typeof managerTemplateNameSchema>;
