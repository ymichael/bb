import { getRequest } from "@tanstack/react-start/server";
import { createAuth } from "./auth.js";
import { getEnv } from "./env.js";

export async function getSessionUserId(): Promise<string | null> {
  const request = getRequest();
  const auth = createAuth(getEnv());
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user?.id ?? null;
}
