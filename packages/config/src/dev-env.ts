import { envsafe, str } from "envsafe";

export const devEnvConfig = envsafe({
  BB_DEV_APP_HOST: str({
    desc: "Development-only Vite bind host for apps/app. Set to 0.0.0.0 to test from phones or other LAN devices. Does not affect production server binding or generated URLs.",
    default: "",
    allowEmpty: true,
    devDefault: "",
  }),
  DEV_CLOUDFLARED_TUNNEL_TOKEN: str({
    desc: "Cloudflare Tunnel token for exposing the local dev server to E2B sandboxes",
    default: "",
    allowEmpty: true,
    devDefault: "",
  }),
});
