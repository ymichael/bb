import CookieManager from "@react-native-cookies/cookies";
import type { CookieStoreLike } from "../session/cookie-store";

export const nativeCookieStore: CookieStoreLike = {
  set: (url, cookie, useWebKit) => CookieManager.set(url, cookie, useWebKit),
};
