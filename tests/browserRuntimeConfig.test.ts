import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeConfig } from "../src/runtimeConfig.ts";
import { runtimeFixture, ZONES, pageOf } from "./fixtures/runtimeConfig.ts";

test("four environments resolve their own explicit endpoints", () => {
  for (const zone of ZONES) {
    const config = runtimeFixture(zone);
    assert.deepEqual({ ...parseRuntimeConfig(config, pageOf(zone)) }, config);
  }
});
