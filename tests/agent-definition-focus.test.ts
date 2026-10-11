import assert from "node:assert/strict";
import test from "node:test";
import { trapDialogFocus } from "../src/agent-definition/focus.ts";

test("modal Tab wraps both ways and skips invisible or disabled controls", () => {
  let focused = "", prevented = 0;
  const first = { getClientRects: () => [1], focus: () => { focused = "first"; } };
  const hidden = { getClientRects: () => [], focus: () => { focused = "hidden"; } };
  const last = { getClientRects: () => [1], focus: () => { focused = "last"; } };
  const ownerDocument = { activeElement: first };
  const dialog = { ownerDocument, querySelectorAll(selector: string) {
    assert.match(selector, /:not\(:disabled\)/);
    return [first, hidden, last];
  } };
  const event = { key: "Tab", shiftKey: true, currentTarget: dialog, preventDefault: () => { prevented++; } };
  trapDialogFocus(event as unknown as KeyboardEvent);
  assert.equal(focused, "last");
  ownerDocument.activeElement = last;
  trapDialogFocus({ ...event, shiftKey: false } as unknown as KeyboardEvent);
  assert.equal(focused, "first");
  trapDialogFocus({ ...event, key: "Escape" } as unknown as KeyboardEvent);
  assert.equal(prevented, 2);
});
