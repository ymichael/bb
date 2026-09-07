
import type { AbsolutePathBuf } from "./AbsolutePathBuf.js";
import type { ImageGenerationFailure } from "./ImageGenerationFailure.js";

export type ImageGenerationItem = { id: string, status: string, revisedPrompt: string | null, result: string, transparentBackground?: boolean, failure: ImageGenerationFailure | null, savedPath?: AbsolutePathBuf, };
