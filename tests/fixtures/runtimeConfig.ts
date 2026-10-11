// Public, non-secret browser endpoints per environment zone (inner domains).
export function runtimeFixture(zone = "dev.ndaeweb.com") {
  return {
    VITE_AUTH_BASE: `https://nucleagent-auth.${zone}`,
    VITE_IM_BASE: `https://nucleagent-im.${zone}`,
    VITE_CORE_BASE: `https://nucleagent-core-web.${zone}`,
    VITE_SHELL_URL: `https://nucleagent-web.${zone}`,
    VITE_SHELL_ALLOWED_ORIGINS: "",
    VITE_ACCOUNT_UI_URL: `https://nucleagent-web.${zone}/remote/account-ui.js`,
  };
}
export const ZONES = ["dev.ndaeweb.com", "debug.ndaeweb.com", "beta.ndaeweb.com", "sdp.ndaeweb.com"];
export const pageOf = (zone = "dev.ndaeweb.com") => `https://nucleagent-im-web.${zone}`;
