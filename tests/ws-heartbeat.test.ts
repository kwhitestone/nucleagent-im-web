// UNI-WS-HEARTBEAT: Kong closes a WebSocket after 60 s with no frame; the SDK's default 60 s
// heartbeat loses that race (the 未连接 flash). The ping must land well inside the 60 s window.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { WKSDK } from "wukongimjssdk";
import { configureSDK } from "../src/im.ts";

after(() => clearInterval((WKSDK.shared().receiptManager as unknown as { timer: ReturnType<typeof setInterval> }).timer));

test("configureSDK pings every 25 s, inside Kong's 60 s idle cut", () => {
  configureSDK({ uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" });
  assert.equal(WKSDK.shared().config.heartbeatInterval, 25000);
});
