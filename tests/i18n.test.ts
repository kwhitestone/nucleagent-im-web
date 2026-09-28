import assert from "node:assert/strict";
import test from "node:test";
import { createI18n } from "vue-i18n";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";

type Messages = Record<string, unknown>;

function flatten(messages: Messages, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.push([path, value]);
    else if (value && typeof value === "object") out.push(...flatten(value as Messages, path));
  }
  return out;
}

const zhKeys = flatten(zh as Messages);
const enKeys = flatten(en as Messages);

// Sample arguments for every interpolated key, so compiling a message also
// proves its placeholders resolve rather than rendering "{count}" literally.
const args: Record<string, Record<string, unknown>> = {
  "list.unreadLabel": { count: 3 },
  "search.noResults": { query: "zhang" },
  "badge.agentCount": { count: 2 },
  "badge.via": { name: "research-bot" },
  "chat.groupMeta": { people: 5, agents: 2 },
  "chat.responding": { name: "research-bot" },
  "composer.removeMention": { name: "research-bot" },
  "group.allowlistTitle": { agent: "research-bot" },
  "group.allowlistOwner": { name: "Chen Mo" },
};

test("both locales define exactly the same keys", () => {
  assert.deepEqual(
    zhKeys.map(([key]) => key).sort(),
    enKeys.map(([key]) => key).sort(),
  );
});

test("no message is empty", () => {
  for (const [key, value] of [...zhKeys, ...enKeys]) {
    assert.ok(value.trim().length > 0, `${key} is empty`);
  }
});

/**
 * The regression this exists for: vue-i18n reserves `@` for linked messages, so
 * a literal "@username" throws "Invalid linked format" at render time and takes
 * the whole view down. An IM product's copy is full of @, and the compile only
 * happens when a message is actually rendered — which is why a build and a
 * type-check both pass while the app is broken. Every message is rendered here.
 */
test("every message compiles and interpolates in both locales", () => {
  for (const locale of ["zh", "en"] as const) {
    const i18n = createI18n({
      legacy: false,
      locale,
      fallbackLocale: "zh",
      messages: { zh, en } as never,
      // Surface a missing/failed interpolation instead of silently degrading.
      missingWarn: true,
      fallbackWarn: false,
    });
    const t = i18n.global.t as (key: string, named?: Record<string, unknown>) => string;

    for (const [key] of zhKeys) {
      const rendered = args[key] ? t(key, args[key]) : t(key);
      assert.ok(rendered.length > 0, `${locale}:${key} rendered empty`);
      assert.ok(!rendered.includes("{"), `${locale}:${key} left an unresolved placeholder: ${rendered}`);
    }
  }
});

test("literal @ survives into the rendered string", () => {
  const i18n = createI18n({
    legacy: false,
    locale: "en",
    fallbackLocale: "zh",
    messages: { zh, en } as never,
  });
  const t = i18n.global.t as (key: string, named?: Record<string, unknown>) => string;
  assert.equal(t("badge.via", { name: "research-bot" }), "via @research-bot");
  assert.ok(t("list.searchPlaceholder").includes("@username"));
});

// UNI-MOBILE-IMPL M2 (board §05): the rail uses line icons + labels, never emoji glyphs.
test("rail tabs are line icons with labels, no emoji", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.doesNotMatch(app, /[💬👥🤖🔍]/u);
  assert.equal((app.match(/class="rail-icon"/g) ?? []).length, 4);
  for (const key of ["chats", "groups", "agents", "search", "me"]) {
    assert.ok((zh as Messages & { tab: Record<string, string> }).tab[key]);
    assert.ok((en as Messages & { tab: Record<string, string> }).tab[key]);
  }
});
