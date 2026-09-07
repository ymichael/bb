
import type { AppReview } from "./AppReview.js";
import type { AppScreenshot } from "./AppScreenshot.js";

export type AppMetadata = { review: AppReview | null, categories: Array<string> | null, subCategories: Array<string> | null, seoDescription: string | null, screenshots: Array<AppScreenshot> | null, developer: string | null, version: string | null, versionId: string | null, versionNotes: string | null, firstPartyRequiresInstall: boolean | null, showInComposerWhenUnlinked: boolean | null, };
