import { test } from "node:test";
import assert from "node:assert";
import { validateChange } from "./guard.js";

test("rejects an img that gains an empty alt", () => {
  const before = '<html><body><img src="a.png"></body></html>';
  const after = '<html><body><img src="a.png" alt=""></body></html>';
  const { ok, reasons } = validateChange(before, after);
  assert.strictEqual(ok, false);
  assert.ok(reasons.some((r) => r.includes("empty alt")), reasons.join("; "));
});

test("rejects a deleted button", () => {
  const before = '<html><body><button>Go</button></body></html>';
  const after = '<html><body></body></html>';
  const { ok } = validateChange(before, after);
  assert.strictEqual(ok, false);
});

test("accepts an added aria-label", () => {
  const before = '<html><body><button></button></body></html>';
  const after = '<html><body><button aria-label="Submit"></button></body></html>';
  const { ok } = validateChange(before, after);
  assert.strictEqual(ok, true);
});

test("rejects adding aria-hidden=true", () => {
  const before = '<html><body><p>Hello</p></body></html>';
  const after = '<html><body><p aria-hidden="true">Hello</p></body></html>';
  const { ok } = validateChange(before, after);
  assert.strictEqual(ok, false);
});
