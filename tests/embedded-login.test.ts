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

test("an agentia host is recognised only through the origin-checked handshake, never a URL flag", () => {
  assert.match(app, /const agentiaHosted = ref\(false\);/);
  assert.match(app, /onInit\(\) \{\s*agentiaHosted\.value = true;/);
  assert.doesNotMatch(app, /searchParams\.get\(["']embed/);
  // Hosted by agentia, im-web owns its refresh cookie; only the nucleagent shell owns refresh.
  // Embedded, a rejected stream token is replaced by the shell's newer push (asking once), never refreshed here.
  assert.match(app, /if \(shellOwnsSession\(\)\) \{\s*streamJwt = await nextShellCredential\([\s\S]*?shellBridge\.reportAuthRequired\("rejected"\)/);
  // Sign-out with no shell to delegate to revokes here instead of asking a shell that is not there.
  const signOut = app.slice(app.indexOf("function signOut"), app.indexOf("// Unmount is app teardown"));
  assert.match(signOut, /if \(agentiaHosted\.value\) \{[\s\S]*teardownSession\(\);[\s\S]*revokeServerSession\(jwt\);/);
});
