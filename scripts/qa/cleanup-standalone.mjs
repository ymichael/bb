import { cleanupStandaloneOrphans } from "./shared.mjs";

async function main() {
  const result = await cleanupStandaloneOrphans();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
