import type { Env } from "./env.js";

export function resolveDevEmailPasswordEnabled(
  env: Pick<Env, "APP_URL" | "BASE_DOMAIN" | "DEV_EMAIL_PASSWORD_AUTH">,
): boolean {
  const value = env.DEV_EMAIL_PASSWORD_AUTH?.trim();
  if (!value) return false;
  if (value !== "true") {
    throw new Error("DEV_EMAIL_PASSWORD_AUTH must be true when set");
  }

  const appUrl = new URL(env.APP_URL);
  const isLocalOrigin =
    appUrl.protocol === "http:" &&
    appUrl.hostname === env.BASE_DOMAIN &&
    env.BASE_DOMAIN.endsWith(".localhost") &&
    appUrl.username === "" &&
    appUrl.password === "" &&
    appUrl.pathname === "/" &&
    appUrl.search === "" &&
    appUrl.hash === "";
  if (!isLocalOrigin) {
    throw new Error(
      "DEV_EMAIL_PASSWORD_AUTH is only allowed for local Cloud development",
    );
  }
  return true;
}
