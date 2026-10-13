import assert from "node:assert/strict";
import test from "node:test";
import { chooseGrokModel, parseGrokModelsOutput } from "../src/lib/grok-run/models.ts";

const SIGNED_IN = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
`;

const UNSIGNED = `You are not authenticated.

Default model: grok-4.6

Available models:
  * grok-4.6 (default)
  - grok-4.5
`;

test("parseGrokModelsOutput reads the signed-in default", () => {
  const listing = parseGrokModelsOutput(SIGNED_IN);
  assert.equal(listing.defaultId, "grok-4.7");
  assert.deepEqual(listing.ids, ["grok-4.7"]);
});

test("chooseGrokModel substitutes an unknown id for the account default", () => {
  const listing = parseGrokModelsOutput(SIGNED_IN);
  assert.equal(chooseGrokModel("grok-4.6", listing), "grok-4.7");
  assert.equal(chooseGrokModel("grok-4.5", listing), "grok-4.7");
  assert.equal(chooseGrokModel("grok-4.7", listing), "grok-4.7");
});

test("chooseGrokModel keeps a listed id and omits -m when the listing failed", () => {
  const listing = parseGrokModelsOutput(UNSIGNED);
  assert.equal(chooseGrokModel("grok-4.5", listing), "grok-4.5");
  assert.equal(chooseGrokModel("grok-4.6", listing), "grok-4.6");
  assert.equal(chooseGrokModel("grok-4", listing), "grok-4.6");
  assert.equal(chooseGrokModel("grok-4.6", null), undefined);
  assert.equal(chooseGrokModel("grok-4.6", { defaultId: null, ids: [] }), undefined);
});
