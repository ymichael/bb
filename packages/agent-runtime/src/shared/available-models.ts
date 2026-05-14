import { availableModelSchema, type AvailableModel } from "@bb/domain";
import { z } from "zod";

const modelListResultSchema = z.object({
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
});

export interface ParsedModelListResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export function parseAvailableModelList(
  result: unknown,
): ParsedModelListResult {
  return modelListResultSchema.parse(result);
}
