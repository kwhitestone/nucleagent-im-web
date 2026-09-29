// UNI-IM-LAYOUT: every scrollable panel fills its layout slot.
//
// The suite has no browser, so this checks the CSS contract the geometry
// follows from (the rendered bottom-edge == slot-bottom evidence at
// 393/900/1440 is in nd-docs uni-im-layout-20260929.md). Adding a panel?
// Put it in PANELS: its column must be a flex column, the panel must be
// `flex: 1; min-height: 0` and scroll itself.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// Declarations of every top-level rule whose selector list contains `selector`
// exactly (media-query rules count too: a phone override can break the slot).
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const [, k, v] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  }
  return out;
}

const COLUMNS = [".sidebar", ".chat"];
// [panel, column it fills]
const PANELS = [
  [".conversation-list", ".sidebar"],
  [".sidebar-tools .contact-results", ".sidebar"],
  [".messages", ".chat"],
  [".empty-chat", ".chat"],
  [".empty-paths", ".chat"],
];

for (const column of COLUMNS) {
  test(`${column} is a flex column that can shrink into its grid cell`, () => {
    const d = decls(column);
    assert.equal(d.display, "flex");
    assert.equal(d["flex-direction"], "column");
    assert.equal(d["min-height"], "0");
  });
}

for (const [panel, column] of PANELS) {
  test(`${panel} fills ${column}: grows, may shrink, scrolls itself`, () => {
    const d = { ...decls(panel.split(" ").pop()!), ...decls(panel) };
    assert.match(d.flex ?? "", /^1\b/, `${panel} needs flex: 1`);
    assert.equal(d["min-height"], "0", `${panel} needs min-height: 0`);
    assert.equal(d["overflow-y"], "auto", `${panel} must scroll inside, not grow the page`);
    assert.equal(d["max-height"] ?? "none", "none", `${panel} must not be capped short of its slot`);
  });
}

test("no panel floats: the directory list is in flow, never absolute/fixed", () => {
  // The defect this task fixed: a 240px absolute card over an empty column.
  for (const sel of [".contact-results", ".sidebar-tools .contact-results"]) {
    assert.ok(!/absolute|fixed/.test(decls(sel).position ?? ""), `${sel} is positioned`);
  }
});

test("an open directory list takes the column from the conversation list", () => {
  assert.equal(decls(".sidebar:has(.sidebar-tools .contact-results) .conversation-list").display, "none");
  assert.match(decls(".sidebar-tools:has(.contact-results)").flex ?? "", /^1\b/);
});

test("the shell uses the visible viewport height on phones", () => {
  assert.match(css, /\.app-shell\s*\{[^}]*height:\s*100dvh/);
});
