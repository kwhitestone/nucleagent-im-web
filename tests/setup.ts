// Preloaded by `npm test`: modules read runtime config at evaluation, as in the browser after boot.ts.
import { loadRuntimeConfig } from "../src/runtimeConfig.ts";
import { pageOf, runtimeFixture } from "./fixtures/runtimeConfig.ts";

await loadRuntimeConfig(pageOf(), (async () => new Response(JSON.stringify(runtimeFixture()))) as typeof fetch);
