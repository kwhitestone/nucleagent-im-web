// IM-AGENT-FAILURE-NOTICE-0830: a failed agent run reads in Chinese, and the
// live error line hands over to the durable notice nucleagent-im now posts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rejectionCopy } from "../src/provenance.ts";
import { isAgentUnavailableNotice, isExecutionFailedNotice } from "../src/send.ts";
import { applyAgentStreamEvent, parseAgentStreamEvent, reconcileLiveResponses } from "../src/stream.ts";

test("execution failure copy is Chinese in zh and unchanged in en", () => {
  assert.equal(rejectionCopy("im_execution_failed", "zh"), "智能体这次没能完成回答，请稍后重试");
  assert.equal(rejectionCopy("im_execution_failed", "en"), "The agent could not complete this request.");
  assert.equal(rejectionCopy("im_execution_failed"), "The agent could not complete this request.");
});

test("the durable failure notice is recognised from systemNotice only", () => {
  const notice = { contentObj: { type: 1, content: "智能体这次没能完成回答，请稍后重试", systemNotice: "execution_failed" } };
  assert.equal(isExecutionFailedNotice(notice), true);
  assert.equal(isAgentUnavailableNotice(notice), false, "must not render as 'agent disabled'");
  assert.equal(isExecutionFailedNotice({ contentObj: { type: 1, content: "智能体这次没能完成回答，请稍后重试" } }), false);
  assert.equal(isExecutionFailedNotice({ contentObj: { systemNotice: "agent_unavailable" } }), false);
  assert.equal(isExecutionFailedNotice(undefined), false);
});

test("the live error line gives way to the durable notice, not before", () => {
  const event = parseAgentStreamEvent({
    id: "5:2", event: "error",
    data: JSON.stringify({ sourceKey: "s", code: "im_execution_failed", clientMsgNo: "im-abc" }),
  });
  assert.deepEqual(event, { id: "5:2", type: "error", sourceKey: "s", code: "im_execution_failed", clientMsgNo: "im-abc" });
  let live = applyAgentStreamEvent([], { id: "5:0", type: "open", sourceKey: "s", agentUid: "8" });
  live = applyAgentStreamEvent(live, event!);
  assert.equal(live[0].status, "error");
  assert.equal(live[0].clientMsgNo, "im-abc");
  assert.equal(reconcileLiveResponses(live, ["other"]).length, 1, "kept until the notice syncs");
  assert.equal(reconcileLiveResponses(live, ["im-abc"]).length, 0, "no double line once it syncs");
  // Older servers send no clientMsgNo: the line stays, as before.
  const legacy = parseAgentStreamEvent({ id: "6:0", event: "error", data: JSON.stringify({ sourceKey: "t", code: "im_execution_failed" }) });
  assert.equal("clientMsgNo" in legacy!, false);
  assert.equal(reconcileLiveResponses(applyAgentStreamEvent([], legacy!), ["im-abc"]).length, 1);
});

test("App renders the durable failure notice as a calm system line in the user's locale", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(app, /<SystemLine v-else-if="isExecutionFailedNotice\(message\.content\)" calm[^>]*>\s*\{\{ rejectionCopy\("im_execution_failed", getLocale\(\)\) \}\}/);
});
