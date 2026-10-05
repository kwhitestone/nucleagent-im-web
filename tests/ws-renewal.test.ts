// UNI-WS-RENEWAL: the shell re-pushes a renewed login token every ~10 min. Re-adopting it minted a
// fresh connect token, and im registers every mint with WuKongIM as the master device, so WuKongIM
// kicked the live socket ~10 s later (the 10-minute 未连接 flash; DEV probe: a bare mint with no
// client teardown closes the WS at +10.0 s). Same user → swap the login token only, no mint.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renewsSameUser, type ConnectSession } from "../src/api.ts";

const jwtFor = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const live: ConnectSession = { uid: "11", token: "im-1", wsAddr: "ws://im", jwt: jwtFor({ userId: 11, iat: 1 }) };

test("same-user renewal (token value changes, userId unchanged) is a renewal", () => {
  assert.equal(renewsSameUser(live, jwtFor({ userId: 11, iat: 2 })), true);
});

test("a user change, no session yet, or an unreadable token is not: the caller rebuilds", () => {
  assert.equal(renewsSameUser(live, jwtFor({ userId: 12, iat: 2 })), false);
  assert.equal(renewsSameUser(undefined, jwtFor({ userId: 11 })), false);
  assert.equal(renewsSameUser(live, "opaque"), false);
  assert.equal(renewsSameUser(live, jwtFor({ sub: "11" })), false);
});

test("adoptShellSession: a same-user renewal swaps the jwt and returns before any connect-token mint", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const adopt = app.slice(app.indexOf("async function adoptShellSession"), app.indexOf("async function restoreSession"));
  const renew = adopt.indexOf("renewsSameUser(session.value, accessToken)");
  assert.ok(renew > 0, "same-user renewal check missing");
  const branch = adopt.slice(renew, adopt.indexOf("return;", renew));
  assert.match(branch, /session\.value = \{ \.\.\.session\.value, jwt: accessToken \};/);
  assert.doesNotMatch(branch, /imSession|startSession|connect\(|disconnect\(/);
  assert.ok(renew < adopt.indexOf("imSession("), "the renewal must short-circuit before the mint");
  assert.match(adopt.slice(renew), /startSession\(await imSession\(\{ accessToken \}\)\)/, "a user change still rebuilds");
});
