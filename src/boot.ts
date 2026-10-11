import { startRuntimeApp } from "./bootstrap.ts";
import { loadRuntimeConfig } from "./runtimeConfig.ts";

void startRuntimeApp(loadRuntimeConfig, async () => {
  await import("./main.ts");
}, window).catch(() => {
  const root = document.getElementById("app");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent = "NucleAgent IM failed to start: runtime configuration is missing, invalid, or unavailable.";
  }
});
