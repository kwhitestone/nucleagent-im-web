import { createRequire } from "node:module";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || "/tmp/c7rev2-clones/node_modules/playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://nucleagent-im-web.dev.ndaeweb.com";
const results = [];
mkdirSync(`${root}/shots`, { recursive: true });
mkdirSync(`${root}/runs`, { recursive: true });
const browser = await chromium.launch({ headless: true });
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail ?? null)}`);
};
const people = Array.from({ length: 12 }, (_, i) => ({
  id: i + 14, portalUid: i + 1014, username: `fixture${i + 14}`, displayName: "Fixture Same Name",
  provisioned: true, accountType: "human", openId: `nduc_fixture_${i + 14}`,
}));
const card = '[data-testid="acct-pc"]';
async function setup(shell, { cold = false, failure = 200, picker = false, mobile = false, lang = "zh", moduleFailure = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  await page.clock.install();
  page.setDefaultTimeout(5000);
  let release, calls = 0, modules = 0;
  const gate = new Promise(done => { release = done; });
  if (!cold) release();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const headers = { "access-control-allow-origin": "*" };
    const json = (data, status = 200) => route.fulfill({ headers, status, contentType: "application/json", body: JSON.stringify(data) });
    if (url.origin === origin && url.pathname === "/") {
      const css = readdirSync(`${root}/build/web`).filter(f => f.endsWith(".css")).map(f => `<link rel="stylesheet" href="/${f}">`).join("");
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>` });
    }
    if (url.pathname.endsWith("account-ui.version.json")) {
      modules++;
      await gate;
      return moduleFailure ? json({}, 503) : json({ version: "deadbeef" });
    }
    if (url.pathname.endsWith("account-ui.js"))
      return route.fulfill({ headers, contentType: "text/javascript", body: readFileSync(`${root}/build/shell-${shell}/account-ui.js`) });
    if (url.pathname.endsWith("/directory/search")) {
      const number = Number(url.searchParams.get("page") || 1);
      return json({ code: 0, data: { items: people.slice((number - 1) * 6, number * 6), page: number, hasMore: number === 1, nextCursor: number === 1 ? "next" : "", degraded: false } });
    }
    if (url.pathname.endsWith("/directory/resolve")) {
      calls++;
      if (failure === "network") return route.abort("failed");
      if (failure === "malformed") return json({ code: 0, data: { items: [{ uid: 14, profile: {} }] } });
      if (typeof failure === "number" && failure !== 200) return json({ code: failure }, failure);
      const body = route.request().postDataJSON();
      const ids = body.uids ?? (body.openIds ?? []).map(id => Number(id.split("_").at(-1)));
      return json({ code: 0, data: { items: ids.map(uid => ({ uid, profile: failure === "missing" ? null : {
        nickName: "Fixture Same Name", username: `fixture${uid}`, avatar: "", accountType: "human",
        provisioned: true, openId: `nduc_fixture_${uid}`, phoneMasked: null,
      } })), degraded: false } });
    }
    if (url.pathname.includes("/im/search")) return json({ messages: [], total: 0, next_cursor: "" });
    if (url.origin === origin && !url.pathname.startsWith("/api/"))
      return route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: readFileSync(`${root}/build/web${url.pathname}`) });
    return json({ code: 0, data: { items: [] } });
  });
  await page.goto(`${origin}/?view=${picker ? "picker" : "search"}&lang=${lang}`);
  await page.waitForFunction(() => !!window.review);
  const input = page.locator(picker ? ".contact-search" : '[data-testid="im-search-input"]');
  await input.fill("fixture");
  await page.locator(picker ? ".contact-result" : '[data-testid="im-search-row-contact"]').first().waitFor();
  const rows = await page.locator(picker ? ".contact-result" : '[data-testid="im-search-row-contact"]').count();
  return { page, context, release, input, rows, calls: () => calls, modules: () => modules,
    recover: () => { failure = 200; },
    close: async () => { check(`${shell} no page exceptions`, errors.length === 0, errors); await context.close(); } };
}
async function tabTo(page, selector, key = "Tab") {
  for (let steps = 0; steps < 40; steps++) {
    if (await page.evaluate(s => document.activeElement?.matches(s), selector)) return true;
    await page.keyboard.press(key);
  }
  return false;
}
try {
  for (const shell of ["main", "host"]) {
    for (const mobile of [false, true]) {
      const label = `${shell}/${mobile ? "mobile" : "desktop"}`;
      const s = await setup(shell, { mobile });
      check(`${label} input initially focused`, await s.input.evaluate(e => document.activeElement === e));
      check(`${label} natural Tab reaches View profile`, await tabTo(s.page, '[data-testid=im-search-info]'));
      await s.page.keyboard.press("Enter");
      await s.page.locator(`${card}[data-state=ready]`).waitFor();
      await s.page.keyboard.press("Escape");
      check(`${label} Esc returns to natural profile trigger`, await s.page.evaluate(() => document.activeElement?.matches("[data-testid=im-search-info]")));
      await s.page.keyboard.press("Tab");
      check(`${label} reverse Tab reaches View profile`, await tabTo(s.page, '[data-testid=im-search-info]', "Shift+Tab"));
      await s.page.keyboard.press("Enter");
      await s.page.locator(`${card}[data-state=ready]`).waitFor();
      await s.page.keyboard.press("Escape");
      check(`${label} ShiftTab returns to input`, await tabTo(s.page, '[data-testid=im-search-input]', "Shift+Tab"));
      check(`${label} query and category retained`, await s.input.inputValue() === "fixture"
        && await s.page.getByTestId("im-search-tab-all").getAttribute("aria-selected") === "true");
      for (const selector of [".avatar", "strong", "[data-testid=im-search-info]"]) {
        const row = s.page.getByTestId("im-search-row-contact").nth(1);
        const trigger = selector === "[data-testid=im-search-info]"
          ? s.page.getByTestId("im-search-info").nth(1) : row.locator(selector);
        if (mobile) await trigger.tap(); else await trigger.click();
        await s.page.locator(`${card}[data-state=ready]`).waitFor();
        check(`${label} ${selector} same-name target`, await s.page.getByTestId("acct-pc-uid").textContent() === "15");
        await s.page.keyboard.press("Escape");
      }
      check(`${label} no accidental chat`, !(await s.page.evaluate(() => review.events.some(e => e.startsWith("contact:")))));
      await s.page.getByTestId("im-search-info").first().click();
      await s.page.locator(`${card}[data-state=ready]`).waitFor();
      const bounds = await s.page.locator(card).boundingBox();
      check(`${label} card fits viewport`, bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= (mobile ? 393 : 1440) + 1);
      await s.page.screenshot({ path: `${root}/shots/${label.replace("/", "-")}-profile.png` });
      await s.close();

      const p = await setup(shell, { picker: true, mobile });
      await p.page.locator(".contact-more").click();
      await p.page.waitForFunction(() => document.querySelectorAll(".contact-result").length === 12);
      await p.page.locator(".contact-results").last().evaluate(e => { e.scrollTop = 80; });
      const scrollBefore = await p.page.locator(".contact-results").last().evaluate(e => e.scrollTop);
      await p.page.locator(".contact-result strong").nth(2).click();
      await p.page.locator(`${card}[data-state=ready]`).waitFor();
      await p.page.getByTestId("acct-pc-name").click();
      await p.page.keyboard.press("Escape");
      const state = await p.page.evaluate(() => ({
        query: document.querySelector(".contact-search").value,
        rows: document.querySelectorAll(".contact-result").length,
        selected: review.selected.value.map(e => e.id), selectedEvent: review.events.includes("select"),
      }));
      check(`${label} picker page/query/selection preserved`, state.query === "fixture" && state.rows === 12
        && state.selected.join() === "90" && !state.selectedEvent, state);
      check(`${label} picker scroll preserved`, scrollBefore > 0
        && await p.page.locator(".contact-results").last().evaluate(e => e.scrollTop) === scrollBefore);
      await p.close();
    }

    for (const scenario of ["close", "reopen", "latest", "repeat", "other-surface"]) {
      const s = await setup(shell, { cold: true, mobile: true });
      await s.page.getByTestId("im-search-info").first().tap();
      if (scenario === "close" || scenario === "reopen") {
        await s.page.getByTestId("im-search-close").tap();
        await s.page.getByTestId("closed").waitFor();
      }
      if (scenario === "latest") await s.page.getByTestId("im-search-info").nth(1).tap();
      if (scenario === "repeat") await s.page.getByTestId("im-search-info").first().tap();
      // Lifecycle control, not a pointer-navigation claim: mobile search covers this fixture button.
      if (scenario === "other-surface") await s.page.evaluate(() => document.getElementById("other-surface").click());
      s.release();
      await s.page.evaluate(() => review.pending);
      if (scenario === "close" || scenario === "reopen") {
        check(`${shell} cold ${scenario} cancels old open`, await s.page.locator(card).count() === 0);
        if (scenario === "reopen") {
          await s.page.evaluate(() => { review.show.value = true; });
          await s.input.fill("fixture");
          await s.page.getByTestId("im-search-info").first().tap();
          await s.page.locator(`${card}[data-state=ready]`).waitFor();
          check(`${shell} reopen same target works`, await s.page.getByTestId("acct-pc-uid").textContent() === "14");
        }
      } else {
        await s.page.locator(`${card}[data-state=ready]`).waitFor();
        const expected = scenario === "latest" ? "15" : scenario === "other-surface" ? "25" : "14";
        check(`${shell} cold ${scenario} only latest card`, await s.page.locator(card).count() === 1
          && await s.page.getByTestId("acct-pc-uid").textContent() === expected);
      }
      check(`${shell} cold ${scenario} single module load`, s.modules() === 1);
      await s.close();
    }

    for (const failure of [401, 403, 404, 503, "network", "malformed", "missing"]) {
      const s = await setup(shell, { failure, mobile: true, lang: failure === 401 ? "en" : "zh" });
      await s.page.getByTestId("im-search-info").first().tap();
      const expected = ({ 401: "unauthenticated", 403: "forbidden", 404: "unavailable", missing: "missing" })[failure] || "error";
      await s.page.locator(`${card}[data-state=${expected}]`).waitFor();
      check(`${shell} ${failure} explicit state`, failure === "missing"
        ? (await s.page.locator(card).innerText()).includes("无此账号")
        : await s.page.getByTestId("acct-pc-error").isVisible());
      const rowsAfter = await s.page.getByTestId("im-search-row-contact").count();
      check(`${shell} ${failure} keeps results`, rowsAfter === s.rows
        && await s.input.inputValue() === "fixture", { before: s.rows, after: rowsAfter });
      if (failure === 401 || failure === 403) {
        const before = s.calls();
        await s.page.clock.runFor(5100);
        check(`${shell} ${failure} no silent retry`, s.calls() === before);
      }
      if (expected === "error") {
        s.recover();
        await s.page.getByTestId("acct-pc-retry").tap();
        await s.page.locator(`${card}[data-state=ready]`).waitFor();
        check(`${shell} ${failure} explicit retry recovers`, await s.page.getByTestId("acct-pc-uid").textContent() === "14");
      }
      if (failure === 403) await s.page.screenshot({ path: `${root}/shots/${shell}-forbidden.png` });
      await s.close();
    }

    const unavailable = await setup(shell, { moduleFailure: true });
    await unavailable.page.getByTestId("im-search-info").first().click();
    await unavailable.page.getByRole("alert").waitFor();
    check(`${shell} module failure preserves query/results`, await unavailable.input.inputValue() === "fixture"
      && await unavailable.page.getByTestId("im-search-row-contact").count() === unavailable.rows);
    await unavailable.close();

    const host = await setup(shell);
    await host.page.evaluate(() => review.open(document.getElementById("other-surface"), {
      uid: "14", host: document.getElementById("profile-host"),
    }));
    await host.page.locator(`${card}[data-state=ready]`).waitFor();
    check(`${shell} optional host contract`, await host.page.locator(`#profile-host ${card}`).count() === (shell === "host" ? 1 : 0));
    await host.page.evaluate(() => review.ui.close());
    check(`${shell} shared close unmounts host/layer`, await host.page.locator(card).count() === 0);
    await host.close();
  }
} catch (error) {
  check("harness error", false, error.stack);
} finally {
  await browser.close();
  writeFileSync(`${root}/runs/browser.json`, JSON.stringify({ mock: true, results }, null, 2));
  const failures = results.filter(r => !r.ok);
  console.log(`TOTAL ${results.length - failures.length}/${results.length}, failures=${failures.length}`);
  process.exitCode = failures.length ? 1 : 0;
}
