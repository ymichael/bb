import { createConnection, migrate } from "../../src/index.js";
import type { DbConnection } from "../../src/index.js";

let migratedTemplate: Buffer | null = null;

function getMigratedTemplate(): Buffer {
  if (migratedTemplate === null) {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      migratedTemplate = db.$client.serialize();
    } finally {
      db.$client.close();
    }
  }

  return migratedTemplate;
}

export function prepareMigratedConnectionTemplate(): void {
  getMigratedTemplate();
}

export function createMigratedConnection(): DbConnection {
  return createConnection(getMigratedTemplate());
}
