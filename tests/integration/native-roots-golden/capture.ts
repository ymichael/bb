import { FIXTURE_VARIANTS } from "./fixtures.js";
import {
  applyProcessEnv,
  captureVariant,
  goldenFilePath,
  writeGolden,
} from "./golden.js";
import { pipeline } from "./pipeline.js";

const providerFilter = new Set(process.argv.slice(2));
const variants = FIXTURE_VARIANTS.filter(
  (variant) =>
    providerFilter.size === 0 || providerFilter.has(variant.providerId),
);
if (variants.length === 0) {
  console.error(`No fixture variant matches ${[...providerFilter].join(", ")}`);
  process.exit(1);
}

for (const variant of variants) {
  const golden = await captureVariant(variant, pipeline, applyProcessEnv);
  await writeGolden(variant, golden);
  const counts = (section: typeof golden.workspace): string =>
    `${section.commands.length} commands, ${section.skills.length} skills`;
  console.log(
    `${variant.providerId}.${variant.variant}: workspace ${counts(golden.workspace)}; userOnly ${counts(golden.userOnly)} -> ${goldenFilePath(variant)}`,
  );
}
