// IM-SEARCH-PROFILE-INTERACTION browser acceptance, MOCK data only (harness.ts). Own tab on CDP 9226.
// The DEV account-ui URL is answered with the local nucleagent-web main build (real shared card).
// Run: flock -w 60 /tmp/cdp9226.lock node acceptance-profile/accept.mjs
import fs from "node:fs";
const PORT = Number(process.env.PORT || 9226), BASE = process.env.BASE || "http://127.0.0.1:26697/acceptance-profile/";
const OUT = "/tmp/ims-profile-interaction/shots"; fs.mkdirSync(OUT, { recursive: true });
const SHELL = "/tmp/ims-profile-interaction/shell/dist/remote/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [], consoleErrors = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`); };

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let seq = 0; const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Fetch.requestPaused") serveShell(msg.params);
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
const send = (method, params = {}, ms = 30000) => new Promise((ok, no) => {
  const id = ++seq; const t = setTimeout(() => no(new Error(`timeout ${method}`)), ms);
  pending.set(id, (msg) => { clearTimeout(t); msg.error ? no(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
let shellDown = false;
function serveShell(p) {
  if (shellDown) return send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" }).catch(() => {});
  const file = p.request.url.includes("account-ui.version.json") ? "account-ui.version.json" : "account-ui.js";
  const body = fs.readFileSync(SHELL + file).toString("base64");
  send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, body,
    responseHeaders: [{ name: "content-type", value: file.endsWith(".json") ? "application/json" : "text/javascript" }, { name: "access-control-allow-origin", value: "*" }] }).catch(() => {});
}
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const waitFor = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(120); } return false; };
let mobile = false;
async function tap(selector, nth = 0) {
  const r = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 12), y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no element ${selector}[${nth}]`);
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  await sleep(250);
}
const key = async (k, code = k, vk = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, ...(k === "Enter" ? { text: "\r" } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); await sleep(250); };
const type = async (text) => { await send("Input.insertText", { text }); await sleep(100); };
const shot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, 60000); fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(data, "base64")); return `${OUT}/${name}.jpg`; };
const card = `document.querySelector('[data-testid="acct-pc"]')`;
const cardName = `(${card}?.querySelector('[data-testid="acct-pc-name"]')?.textContent || "")`;
const events = () => ev(`__events.slice()`);
const resetEvents = () => ev(`__events.length = 0`);
const navigate = async (url) => { await send("Page.navigate", { url }); await waitFor(`!!document.querySelector("#app > main")`, 30000); await sleep(300); };

const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900, mobile: false }, { name: "phone", width: 393, height: 852, mobile: true }];
const shots = [];
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*nucleagent-web.dev.ndaeweb.com/remote/account-ui*" }] });
  for (const vp of VIEWPORTS) {
    mobile = vp.mobile;
    const tag = vp.name;
    await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });

    // ---- Search page ----
    await navigate(`${BASE}?view=search`);
    await ev(`document.querySelector('[data-testid="im-search-input"]').focus()`);
    await type("测试");
    check(`${tag} search: people listed`, await waitFor(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 3`), await ev(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length`));
    await tap('[data-testid="im-search-tab-contacts"]');
    await waitFor(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 6`);
    const btn = await ev(`(() => { const b = document.querySelector('[data-testid="im-search-info"]').getBoundingClientRect(); const e = document.querySelector('[data-testid="im-search-info"]'); return { w: Math.round(b.width), h: Math.round(b.height), text: e.textContent.trim(), label: e.getAttribute("aria-label") }; })()`);
    check(`${tag} search: visible 查看资料 button, >=44px`, btn.text === "查看资料" && btn.w >= 44 && btn.h >= 44 && btn.label.startsWith("查看资料"), btn);
    shots.push(await shot(`${tag}-search-rows`));
    // scroll the results so we can check it is kept
    await ev(`(() => { const s = document.querySelector(".search-results"); s.style.maxHeight = "200px"; s.style.overflowY = "auto"; s.scrollTop = 60; })()`);
    check(`${tag} search: results scrolled for the keep-scroll check`, await ev(`document.querySelector(".search-results").scrollTop > 0`), await ev(`document.querySelector(".search-results").scrollTop`));
    const before = await ev(`({ q: document.querySelector('[data-testid="im-search-input"]').value, rows: document.querySelectorAll('[data-testid="im-search-row-contact"]').length, scroll: document.querySelector(".search-results").scrollTop })`);

    await resetEvents();
    // row 1 is fully visible at this scroll, so the tap itself does not scroll
    await tap('[data-testid="im-search-row-contact"] .avatar', 1);
    check(`${tag} search: avatar opens the card, no chat`, await waitFor(`!!${card} && /测试林雨/.test(${cardName})`) && (await events()).includes("profile:15") && !(await events()).some((e) => e.startsWith("contact:")), await events());
    shots.push(await shot(`${tag}-search-card-avatar`));
    await key("Escape", "Escape", 27);
    check(`${tag} search: Esc closes only the card; query, rows and scroll kept`, await ev(`!${card} && !!document.querySelector('[data-testid="im-search-panel"]')`) && JSON.stringify(await ev(`({ q: document.querySelector('[data-testid="im-search-input"]').value, rows: document.querySelectorAll('[data-testid="im-search-row-contact"]').length, scroll: document.querySelector(".search-results").scrollTop })`)) === JSON.stringify(before) && !(await events()).includes("close"), { before, events: await events() });

    await resetEvents();
    await tap('[data-testid="im-search-row-contact"] strong.profile-target', 1);
    check(`${tag} search: name of same-named 2nd account opens ITS card (UID 15)`, await waitFor(`!!${card}`) && (await events()).includes("profile:15") && !(await events()).some((e) => e.startsWith("contact:")), await events());
    // Rapid switch: tap three people while resolve is slow; only the last shows.
    await ev(`__resolveDelay = 800`);
    await resetEvents();
    await tap('[data-testid="im-search-info"]', 4);
    await tap('[data-testid="im-search-info"]', 5);
    await tap('[data-testid="im-search-info"]', 0);
    await sleep(1300);
    check(`${tag} search: quick switching shows only the last target`, await ev(`document.querySelectorAll('[data-testid="acct-pc"]').length === 1 && /测试林雨/.test(${cardName})`), { n: await ev(`document.querySelectorAll('[data-testid="acct-pc"]').length`), name: await ev(cardName) });
    await ev(`__resolveDelay = 0`);
    await key("Escape", "Escape", 27);

    // "View profile" via keyboard: Tab to it, Enter.
    await ev(`document.querySelector('[data-testid="im-search-info"]').focus()`);
    await resetEvents();
    await key("Enter", "Enter", 13);
    check(`${tag} search: keyboard Enter on 查看资料 opens the card`, await waitFor(`!!${card}`) && !(await events()).some((e) => e.startsWith("contact:")), await events());
    await key("Escape", "Escape", 27);
    check(`${tag} search: Esc returns focus to the button`, await ev(`document.activeElement?.dataset?.testid === "im-search-info" && !${card}`));

    // Missing / failing profile: clear state, no fake, results kept.
    const rowOf = (name) => ev(`[...document.querySelectorAll('[data-testid="im-search-row-contact"]')].findIndex((r) => r.textContent.includes(${JSON.stringify(name)}))`);
    await tap('[data-testid="im-search-info"]', await rowOf("测试无资料"));
    check(`${tag} search: no profile → card says 无此账号, no invented data`, await waitFor(`/无此账号/.test(${card}?.textContent || "")`), await ev(`${card}?.textContent`));
    shots.push(await shot(`${tag}-search-card-missing`));
    await key("Escape", "Escape", 27);
    await tap('[data-testid="im-search-info"]', await rowOf("测试加载失败"));
    await sleep(1200);
    const failing = await ev(`({ text: ${card}?.textContent || "", rows: document.querySelectorAll('[data-testid="im-search-row-contact"]').length })`);
    check(`${tag} search: resolve 5xx → card keeps the row's known name (no invented fields), results kept`, /测试加载失败/.test(failing.text) && failing.rows === before.rows, failing);
    shots.push(await shot(`${tag}-search-card-5xx`));
    await key("Escape", "Escape", 27);

    // Row body still opens the chat.
    await resetEvents();
    await tap('[data-testid="im-search-row-contact"] small', 0);
    check(`${tag} search: rest of the row still messages`, (await events()).includes("contact:14"), await events());

    // 429: kept people still open their card.
    await navigate(`${BASE}?view=search`);
    await ev(`document.querySelector('[data-testid="im-search-input"]').focus()`);
    await type("测试林");
    await waitFor(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 2`);
    await ev(`__limit = true`);
    await type("雨");
    check(`${tag} search: 429 hint shown, previous people kept`, await waitFor(`!!document.querySelector('[data-testid="im-search-rate-limited"]')`) && await ev(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 2`));
    await resetEvents();
    await tap('[data-testid="im-search-row-contact"] .avatar', 0);
    check(`${tag} search: after 429 the card still opens`, await waitFor(`!!${card}`) && !(await events()).some((e) => e.startsWith("contact:")), await events());
    shots.push(await shot(`${tag}-search-429-card`));
    await key("Escape", "Escape", 27);
    await ev(`__limit = false`);

    // ---- Picker (group selection) ----
    await navigate(`${BASE}?view=picker`);
    await ev(`document.querySelector(".contact-search").focus()`);
    await type("测试成员");
    await waitFor(`document.querySelectorAll(".contact-result").length >= 6`);
    await tap(".contact-more");
    check(`${tag} picker: second page loaded`, await waitFor(`document.querySelectorAll(".contact-result").length >= 12`), await ev(`document.querySelectorAll(".contact-result").length`));
    const pBefore = await ev(`({ q: document.querySelector(".contact-search").value, rows: document.querySelectorAll(".contact-result").length, sel: __selected.value.length })`);
    await resetEvents();
    await tap(".contact-result strong.profile-target", 2);
    check(`${tag} picker: name opens the card, nothing picked`, await waitFor(`!!${card}`) && (await events()).includes("profile:102") && await ev(`__selected.value.length === 0`), await events());
    shots.push(await shot(`${tag}-picker-card`));
    await tap('[data-testid="acct-pc-name"]');
    check(`${tag} picker: tapping inside the card keeps the list`, await ev(`document.querySelectorAll(".contact-result").length === ${pBefore.rows} && !!${card}`));
    await key("Escape", "Escape", 27);
    check(`${tag} picker: Esc closes the card only; query, page-2 rows, selection kept`, JSON.stringify(await ev(`({ q: document.querySelector(".contact-search").value, rows: document.querySelectorAll(".contact-result").length, sel: __selected.value.length })`)) === JSON.stringify(pBefore) && await ev(`!${card}`), pBefore);
    await ev(`document.querySelectorAll('[data-testid="im-picker-info"]')[1].focus()`);
    await key("Enter", "Enter", 13);
    await waitFor(`!!${card}`);
    const sel = await ev(`[...${card}.querySelectorAll("button")].map((b) => b.textContent.trim())`);
    check(`${tag} picker: keyboard 查看资料 opens the card; its primary is 选择 (picker semantics kept)`, sel.includes("选择"), sel);
    await ev(`[...${card}.querySelectorAll("button")].find((b) => b.textContent.trim() === "选择").click()`);
    check(`${tag} picker: card 选择 picks that person`, await waitFor(`__selected.value.length === 1`) && await ev(`__selected.value[0].id === 101`), await ev(`__selected.value.map((c) => c.id)`));
    await ev(`document.querySelector(".contact-search").focus()`);
    await type("测试成员");
    await waitFor(`document.querySelectorAll(".contact-result").length >= 5`);
    await resetEvents();
    await tap(".contact-result small", 0);
    check(`${tag} picker: row body (not the name) still picks`, await waitFor(`__selected.value.length === 2`) && !(await events()).some((e) => e.startsWith("profile:")), await events());
  }

  // account-ui cannot load → explicit toast, results untouched (desktop, fresh page so the loader re-runs).
  mobile = false;
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  shellDown = true;
  await navigate(`${BASE}?view=search`);
  await ev(`document.querySelector('[data-testid="im-search-input"]').focus()`);
  await type("测试");
  await waitFor(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 3`);
  await tap('[data-testid="im-search-info"]', 0);
  check("account-ui down: toast says the card cannot open; rows kept", await waitFor(`/资料卡暂时无法打开/.test(document.querySelector(".toast")?.textContent || "")`) && await ev(`document.querySelectorAll('[data-testid="im-search-row-contact"]').length >= 3`));
  shots.push(await shot("desktop-account-ui-down"));
  shellDown = false;

  // English copy.
  await ev(`localStorage.setItem("nucleagent_locale", "en")`);
  await navigate(`${BASE}?view=search`);
  await ev(`document.querySelector('[data-testid="im-search-input"]').focus()`);
  await type("测试");
  await waitFor(`!!document.querySelector('[data-testid="im-search-info"]')`);
  check("en: View profile label", await ev(`document.querySelector('[data-testid="im-search-info"]').textContent.trim() === "View profile" && document.querySelector('[data-testid="im-search-info"]').getAttribute("aria-label").startsWith("View profile")`));
  shots.push(await shot("desktop-en"));
  await ev(`localStorage.removeItem("nucleagent_locale")`);
} catch (error) {
  check("script error", false, String(error && error.stack || error));
} finally {
  const relevant = consoleErrors.filter((e) => e && !/account-ui unavailable|ConnectionRefused|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e));
  check("console errors = 0 (expected account-ui-down warning excluded)", relevant.length === 0, relevant.slice(0, 5));
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync("/tmp/ims-profile-interaction/accept-out.json", JSON.stringify({ mock: true, passed, total: results.length, results, shots, consoleErrors }, null, 1));
  console.log(`TOTAL ${passed}/${results.length}`);
  try { await send("Target.closeTarget", { targetId: target.id }, 5000); } catch { await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {}); }
  ws.close();
}
