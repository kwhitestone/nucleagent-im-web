import assert from "node:assert/strict";
import test from "node:test";
import { outerAware } from "../src/outerHost.ts";

const OUTER_PAGE = "nucleagent-web.new.ndhy.com";

test("outer page switches inner URLs to their outer twins, keeping path and shape", () => {
  assert.equal(outerAware("https://nucleagent-auth.sdp.ndaeweb.com", OUTER_PAGE), "https://nucleagent-auth.new.ndhy.com");
  assert.equal(outerAware("https://nucleagent-core-web.sdp.ndaeweb.com/", OUTER_PAGE), "https://nucleagent-core-web.new.ndhy.com/");
  assert.equal(outerAware("https://nucleagent-web.sdp.ndaeweb.com/remote/account-ui.js", OUTER_PAGE),
    "https://nucleagent-web.new.ndhy.com/remote/account-ui.js");
});

test("inner, local and unrelated pages leave URLs untouched", () => {
  for (const host of ["nucleagent-web.sdp.ndaeweb.com", "localhost", "", "evil.new.ndhy.com.example.test"]) {
    assert.equal(outerAware("https://nucleagent-auth.sdp.ndaeweb.com", host), "https://nucleagent-auth.sdp.ndaeweb.com");
  }
});

test("outer page leaves non-inner, relative and empty URLs untouched", () => {
  for (const url of ["", "/core-api", "http://localhost:26670", "https://agentia-engine-web.new.ndhy.com",
    "https://sdp.ndaeweb.com.evil.test", "https://evilsdp.ndaeweb.com"]) {
    assert.equal(outerAware(url, OUTER_PAGE), url);
  }
});

test("defaults to the current page host", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: { hostname: OUTER_PAGE }, configurable: true });
  try {
    assert.equal(outerAware("https://nucleagent-im.sdp.ndaeweb.com"), "https://nucleagent-im.new.ndhy.com");
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete (globalThis as { location?: unknown }).location;
  }
});
