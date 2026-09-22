import assert from "node:assert/strict";
import test from "node:test";
import { MessageText } from "wukongimjssdk";
import { isAgentRelayed, readProvenance, rejectionCopy } from "../src/provenance.ts";
import { applyAgentStreamEvent } from "../src/stream.ts";

/** Decodes a durable payload exactly as the SDK does when a message arrives. */
function decoded(payload: Record<string, unknown>) {
  const content = new MessageText("");
  content.decode(new TextEncoder().encode(JSON.stringify(payload)));
  return content;
}

test("provenance is read from the stamped durable agent payload", () => {
  const content = decoded({
    type: 1,
    content: "Paris",
    a2a: { chainId: "chain:7", depth: 2, originUid: 5, viaUid: 42 },
  });
  assert.deepEqual(readProvenance(content), {
    chainId: "chain:7",
    depth: 2,
    originUid: "5",
    viaUid: "42",
  });
});

test("an unstamped message has no provenance and no relay badge", () => {
  const content = decoded({ type: 1, content: "hello" });
  assert.equal(readProvenance(content), null);
  assert.equal(isAgentRelayed(null), false);
});

test("the relay badge marks agent hops only, never a human-triggered answer", () => {
  // depth 1 is the human's own trigger: an agent answered a person, not another agent.
  assert.equal(
    isAgentRelayed(readProvenance(decoded({
      type: 1,
      content: "42",
      a2a: { chainId: "chain:7", depth: 1, originUid: 5, viaUid: 0 },
    }))),
    false,
  );
  assert.equal(
    isAgentRelayed(readProvenance(decoded({
      type: 1,
      content: "Paris",
      a2a: { chainId: "chain:7", depth: 2, originUid: 5, viaUid: 42 },
    }))),
    true,
  );
});

test("429-domain guard rejections get their own system copy", () => {
  assert.match(rejectionCopy("a2a_depth_exceeded"), /depth limit/);
  assert.match(rejectionCopy("a2a_budget_exceeded"), /budget/);
  assert.match(rejectionCopy("im_agent_rate_limited"), /Too many requests/);
  // Anything else keeps the neutral M2 copy rather than leaking an internal code.
  assert.equal(rejectionCopy("im_execution_failed"), "The agent could not complete this request.");
  assert.equal(rejectionCopy(""), "The agent could not complete this request.");
});

test("the stream carries the failure code so the UI can name the guard that fired", () => {
  const responses = applyAgentStreamEvent([], {
    id: "1:0",
    type: "error",
    sourceKey: "source",
    code: "a2a_depth_exceeded",
  });
  assert.equal(responses[0].status, "error");
  assert.equal(responses[0].code, "a2a_depth_exceeded");
  assert.match(rejectionCopy(responses[0].code!), /depth limit/);
});
