import type { PathListIncludeQueryValue } from "@bb/server-contract";
import { ApiError } from "../errors.js";

export interface PathKindInclusion {
  includeFiles: boolean;
  includeDirectories: boolean;
}

export interface ParsePathKindInclusionArgs {
  includeFiles: PathListIncludeQueryValue;
  includeDirectories: PathListIncludeQueryValue;
}

function parsePathIncludeQueryValue(value: PathListIncludeQueryValue): boolean {
  return value === "true";
}

export function parsePathKindInclusion(
  args: ParsePathKindInclusionArgs,
): PathKindInclusion {
  const inclusion = {
    includeFiles: parsePathIncludeQueryValue(args.includeFiles),
    includeDirectories: parsePathIncludeQueryValue(args.includeDirectories),
  };

  if (!inclusion.includeFiles && !inclusion.includeDirectories) {
    throw new ApiError(
      400,
      "invalid_request",
      "At least one path kind must be included",
    );
  }

  return inclusion;
}
