import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { compile } from "@vue/compiler-dom";
import * as Vue from "vue";

const app = parse(readFileSync("src/App.vue", "utf8")).descriptor;
const panel = parse(readFileSync("src/components/SearchPanel.vue", "utf8")).descriptor;
function functions(script: string, names: string[]) {
  const ast = ts.createSourceFile("handlers.ts", script, ts.ScriptTarget.Latest, true);
  return ts.transpileModule(ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ""))
    .map(n => n.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const appCode = functions(app.scriptSetup!.content, ["selectRail", "focusSearch", "openFromSearch"]);
const panelCode = functions(panel.scriptSetup!.content, ["onKeydown", "pick"]);
const rail = app.template!.content.match(/<nav class="rail"[\s\S]*?<span class="rail-spacer"/)![0]
  .replace(/<span class="rail-spacer"$/, "</nav>");
const renderRail = new Function("Vue", compile(rail, { mode: "function" }).code)(Vue);

function harness(mobile = false) {
  const channel = { channelID: "owned-fixture", channelType: 2 };
  const calls: unknown[][] = [];
  const state = {
    railMode: { value: "all" }, searchOpen: { value: true },
    hiddenOpen: { value: false }, activeChannel: { value: channel },
    window: { matchMedia: (media: string) => ({ matches: mobile && media === "(max-width: 720px)" }) },
    nextTick: (fn: () => void) => fn(),
    document: { querySelector: () => ({ focus: () => calls.push(["focus"]) }) },
    batch: { stopSelecting: () => calls.push(["stopSelecting"]) },
    openChannel: (...args: unknown[]) => calls.push(["openChannel", ...args]),
  };
  const context = createContext(state);
  runInContext(appCode, context);
  return { state, channel, calls, run: (code: string) => runInContext(code, context) };
}

for (const mobile of [false, true]) {
  for (const mode of ["all", "groups", "agents"]) {
    test(`search to ${mode}: closes search and ${mobile ? "shows mobile list" : "preserves desktop chat"}`, () => {
      const h = harness(mobile);
      h.run(`selectRail('${mode}')`);
      assert.equal(h.state.searchOpen.value, false);
      assert.equal(h.state.railMode.value, mode);
      assert.equal(h.state.activeChannel.value, mobile ? undefined : h.channel);
      assert.deepEqual(h.calls, [], "navigation performs no conversation I/O");
      h.run("focusSearch()");
      assert.equal(h.state.searchOpen.value, true);
      h.run(`selectRail('${mode}')`);
      assert.equal(h.state.searchOpen.value, false, "repeated roundtrip needs no refresh");
    });
  }
}

test("rendered rail has exactly one active/pressed destination and real handlers for every mode", () => {
  for (const searchOpen of [true, false]) for (const railMode of ["all", "groups", "agents"]) {
    const calls: string[] = [];
    const vnode = renderRail({ searchOpen, railMode, totalUnread: 0, t: (s: string) => s,
      selectRail: (s: string) => calls.push(s), focusSearch: () => calls.push("search") }, []);
    const buttons = vnode.children.filter((n: Vue.VNode) => n.type === "button");
    assert.equal(buttons.length, 4);
    const expected = searchOpen ? 3 : ["all", "groups", "agents"].indexOf(railMode);
    buttons.forEach((button: Vue.VNode, index: number) => {
      assert.equal(button.props!["aria-pressed"], index === expected, `pressed ${searchOpen}/${railMode}/${index}`);
      assert.equal(button.props!.class.split(/\s+/).includes("active"), index === expected, `active ${searchOpen}/${railMode}/${index}`);
      button.props!.onClick();
    });
    assert.deepEqual(calls, ["all", "groups", "agents", "search"]);
  }
});

test("search entry focuses input and preserves the conversation without opening it", () => {
  const h = harness();
  h.state.searchOpen.value = false;
  h.run("focusSearch()");
  assert.equal(h.state.searchOpen.value, true);
  assert.equal(h.state.activeChannel.value, h.channel);
  assert.deepEqual(h.calls, [["stopSelecting"], ["focus"]]);
});

test("selecting a fixture result closes search before opening its channel", () => {
  const h = harness();
  h.run("openFromSearch({channelID:'result-fixture',channelType:2}, 42)");
  assert.equal(h.state.searchOpen.value, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], "openChannel");
  assert.equal((h.calls[0][1] as { channelID: string }).channelID, "result-fixture");
});

test("Esc clears a query first, then closes; selecting a conversation emits the real row", () => {
  const events: unknown[][] = [];
  const query = { value: "fixture" };
  const context = createContext({ query, emit: (...args: unknown[]) => events.push(args),
    props: { session: { uid: "owned-fixture" } }, recent: { value: [] },
    rememberSearch() {}, loadRecentSearches: () => [] });
  runInContext(panelCode, context);
  runInContext("onKeydown({key:'Escape',preventDefault(){},stopPropagation(){}})", context);
  assert.equal(query.value, "");
  assert.deepEqual(events, []);
  runInContext("onKeydown({key:'Escape',preventDefault(){},stopPropagation(){}})", context);
  assert.deepEqual(events, [["close"]]);
  runInContext("pick({kind:'conversation',conversation:{fixture:true}})", context);
  assert.equal(events[1][0], "conversation");
  assert.equal((events[1][1] as { fixture: boolean }).fixture, true);
});
