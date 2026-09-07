import path from "node:path";
import { ApiError } from "../errors.js";

interface SafeRelativeRoutePath {
  relativePath: string;
}

export function parseSafeRelativeRoutePath(
  relativePath: string,
): SafeRelativeRoutePath {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new ApiError(400, "invalid_path", "Invalid file path");
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new ApiError(400, "invalid_path", "Invalid file path");
  }

  return { relativePath };
}
