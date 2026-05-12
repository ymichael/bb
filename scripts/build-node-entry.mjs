import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNodeEsmEntry,
  copyDirectory,
  generateTemplatesIfRequested,
} from "./build-utils.mjs";

const packageRoot = process.cwd();
const [entryPointArg, outfileArg, ...flags] = process.argv.slice(2);

if (!entryPointArg || !outfileArg) {
  throw new Error(
    "Usage: node scripts/build-node-entry.mjs <entrypoint> <outfile> [--clean-dist] [--executable] [--templates] [--copy-dir <from> <to>]",
  );
}

function parseCopyDirectories(args) {
  const copyDirectories = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--copy-dir") {
      continue;
    }

    const from = args[index + 1];
    const to = args[index + 2];
    if (!from || !to) {
      throw new Error("--copy-dir requires <from> and <to> arguments");
    }

    copyDirectories.push({
      from: path.resolve(packageRoot, from),
      to: path.resolve(packageRoot, to),
    });
    index += 2;
  }
  return copyDirectories;
}

await generateTemplatesIfRequested(flags.includes("--templates"));

await buildNodeEsmEntry({
  cleanDist: flags.includes("--clean-dist"),
  entryPoint: path.resolve(packageRoot, entryPointArg),
  executable: flags.includes("--executable"),
  outfile: path.resolve(packageRoot, outfileArg),
  packageRoot,
});

for (const copyArgs of parseCopyDirectories(flags)) {
  await copyDirectory(copyArgs);
}
