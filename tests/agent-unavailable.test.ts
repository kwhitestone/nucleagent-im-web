// AGENT-REPLY-1 (D50): a stopped or deleted agent answers with a system notice,
// and the composer for its DM is greyed out with the same wording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAgentUnavailableNotice, recipientDisabledKey } from "../src/send.ts";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";

test("the bridge notice is recognised from the decoded payload only", () => {
  assert.equal(isAgentUnavailableNotice({ contentObj: { type: 1, content: "x", systemNotice: "agent_unavailable" } }), true);
  assert.equal(isAgentUnavailableNotice({ contentObj: { type: 1, content: "该智能体已停用" } }), false, "plain text never renders as a notice");
  assert.equal(isAgentUnavailableNotice({ contentObj: { systemNotice: "other" } }), false);
  assert.equal(isAgentUnavailableNotice(undefined), false);
});

test("stopped and deleted agents share one wording, without time", () => {
  assert.equal(recipientDisabledKey(true), "composer.agentDisabled");
  assert.equal(recipientDisabledKey(false), "composer.recipientDisabled");
  assert.equal(zh.composer.agentDisabled, "该智能体已停用");
  assert.equal(zh.system.agentUnavailable, "该智能体已停用");
  assert.equal(zh.system.agentUnavailableHint, "如需继续使用，请联系它的创建者或管理员");
  assert.equal(en.system.agentUnavailable, "This agent has been disabled.");
  assert.equal(en.system.agentUnavailableHint, "Contact its owner or an admin to use it again.");
  assert.equal("agentDeleted" in zh.composer, false);
});

test("App renders the notice as a system line and greys the composer", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(app, /<SystemLine v-if="isAgentUnavailableNotice\(message\.content\)"[^>]*calm/);
  assert.match(app, /:disabled="peerUnavailable"/);
  assert.match(app, /peerUnavailable \? t\("composer\.agentDisabled"\)/);
  const send = readFileSync(new URL("../src/send.ts", import.meta.url), "utf8");
  assert.doesNotMatch(send, /only when its definition is deleted/);
});
