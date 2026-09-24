import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const template = app.slice(app.indexOf("<template>"));
const block = (start: string) => {
  const from = template.indexOf(start);
  return template.slice(from, template.indexOf("</main>", from));
};

test("embedded no-session shows no login UI (UNI L3)", () => {
  const embedded = block('<main v-if="!session && embedded"');
  assert.doesNotMatch(embedded, /<form|<input|<button/);
  assert.match(embedded, /login\.redirectingTitle/);
});

test("standalone keeps the full sign-in form", () => {
  const standalone = block('<main v-else-if="!session" class="login-page"');
  assert.match(standalone, /<form[\s\S]*@click="portalLogin"[\s\S]*<input[\s\S]*type="password"/);
});

test("embedded runs never start a portal login from inside the frame", () => {
  const portal = app.slice(app.indexOf("async function portalLogin"), app.indexOf("async function resumePortalLogin"));
  assert.doesNotMatch(portal, /requestLogin/);
  assert.match(app, /if \(embedded\) signInViaShell\(\);/);
});
