// IM-FIX-1 (需求2): a group the viewer was just pulled into is missing from `groups` until the
// next listGroups, so its title, members and @-agents stayed empty until a page reload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelTypeGroup, ChannelTypePerson } from "wukongimjssdk";
import { throttle, unknownGroup } from "../src/groupSync.ts";

const app = readFileSync("src/App.vue", "utf8");
const groups = [{ wukongChannelId: "group_8" }];

test("a group channel absent from the loaded group list is unknown; DMs and known groups are not", () => {
  assert.equal(unknownGroup({ channelID: "group_9", channelType: ChannelTypeGroup }, groups), true);
  assert.equal(unknownGroup({ channelID: "group_8", channelType: ChannelTypeGroup }, groups), false);
  assert.equal(unknownGroup({ channelID: "42", channelType: ChannelTypePerson }, groups), false);
});

test("throttle shares an in-flight run and skips re-runs of the same key within the window", async () => {
  let clock = 0;
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const once = throttle(3000, () => clock);
  const run = () => { runs += 1; return gate; };
  const first = once("g", run);
  assert.equal(once("g", run), first, "concurrent callers share the pending run");
  release();
  await first;
  clock = 2999;
  await once("g", run);
  assert.equal(runs, 1, "within the window after it settled");
  await once("other", async () => { runs += 1; });
  assert.equal(runs, 2, "keys are independent");
  clock = 3000;
  await once("g", async () => { runs += 1; });
  assert.equal(runs, 3, "after the window it runs again");
});

test("App refreshes groups when a conversation or an opened channel names an unknown group", () => {
  const listener = app.slice(app.indexOf("const conversationListener"), app.indexOf("const messageListener"));
  assert.match(listener, /unknownGroup\(conversation\.channel, groups\.value\)[\s\S]*refreshGroups\(\)/);
  const open = app.slice(app.indexOf("async function openChannel"), app.indexOf("function openContact"));
  assert.match(open, /unknownGroup\(channel, groups\.value\)[\s\S]*refreshGroups\(\)/);
});

test("App reloads the open group's members when a message arrives from a sender it does not list", () => {
  const listener = app.slice(app.indexOf("const messageListener"), app.indexOf("const eventListener"));
  assert.match(listener, /refreshMembers\(/);
});
