CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" integer NOT NULL,
  "image" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apikey" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "start" text,
  "prefix" text,
  "key" text NOT NULL,
  "referenceId" text NOT NULL,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" integer,
  "enabled" integer NOT NULL,
  "rateLimitEnabled" integer NOT NULL,
  "rateLimitTimeWindow" integer NOT NULL,
  "rateLimitMax" integer NOT NULL,
  "requestCount" integer NOT NULL,
  "remaining" integer,
  "lastRequest" integer,
  "expiresAt" integer,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  "permissions" text,
  "metadata" text,
  "configId" text NOT NULL,
  FOREIGN KEY ("referenceId") REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apikey_key_unique" ON "apikey" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apikey_reference_id_idx" ON "apikey" ("referenceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apikey_config_id_idx" ON "apikey" ("configId");
