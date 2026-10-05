// UNI-WS-RENEWAL: the shell re-pushes a renewed login token every ~10 min. Rebuilding the
// session for it tore the IM socket down (the 10-minute 未连接 flash). Same user → keep the
// socket; only an actual user change rebuilds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { WKSDK } from "wukongimjssdk";
import { configureSDK, renewInPlace } from "../src/im.ts";

after(() => clearInterval((WKSDK.shared().receiptManager as unknown as { timer: ReturnType<typeof setInterval> }).timer));

const live = { uid: "11", token: "im-1", wsAddr: "ws://im", jwt: "login-1" };

function countSocketCalls(run: () => void): number {
  const sdk = WKSDK.shared();
  const { connect, disconnect } = sdk;
  let calls = 0;
  sdk.connect = () => { calls += 1; };
  sdk.disconnect = () => { calls += 1; };
  try { run(); } finally { sdk.connect = connect; sdk.disconnect = disconnect; }
  return calls;
}

test("same-user renewal (token changes, uid does not): no reconnect, fresh IM token for the next one", () => {
  configureSDK(live);
  let renewed = false;
  const calls = countSocketCalls(() => {
    renewed = renewInPlace(live, { ...live, token: "im-2", jwt: "login-2" });
  });
  assert.equal(renewed, true);
  assert.equal(calls, 0);
  assert.equal(WKSDK.shared().config.token, "im-2");
  assert.equal(WKSDK.shared().config.uid, "11");
});

test("a user change (or no session yet) is not a renewal: the caller rebuilds", () => {
  configureSDK(live);
  assert.equal(renewInPlace(live, { ...live, uid: "12", token: "im-x", jwt: "login-x" }), false);
  assert.equal(renewInPlace(undefined, live), false);
  assert.equal(WKSDK.shared().config.token, "im-1");
});

test("adoptShellSession renews in place first and only rebuilds via startSession otherwise", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const adopt = app.slice(app.indexOf("async function adoptShellSession"), app.indexOf("async function restoreSession"));
  assert.match(adopt, /if \(renewInPlace\(session\.value, next\)\) session\.value = next;\s*else startSession\(next\);/);
});
