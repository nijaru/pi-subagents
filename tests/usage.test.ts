import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { UsageSchema } from "../extensions/pi-subagents/result-schema.ts";
import { addUsage, emptyUsage, isUsage, type UsageRecord } from "../extensions/pi-subagents/types.ts";

const usage = (totalFromProvider?: boolean): UsageRecord => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0.5, totalFromProvider },
});

test.each([
  [true, true, true], [true, false, false], [false, true, false],
  [true, undefined, false], [undefined, true, false],
] as const)("combines cost provenance %s + %s as %s", (first, second, expected) => {
  const total = emptyUsage();
  addUsage(total, usage(first));
  addUsage(total, usage(second));
  expect(total.cost).toEqual({ input: 2, output: 4, cacheRead: 0, cacheWrite: 0, total: 1, totalFromProvider: expected });
  expect(Check(UsageSchema, total)).toBe(true);
});

test("zero billed records still contribute to aggregate provenance", () => {
  for (const flag of [false, true]) {
    const total = emptyUsage();
    const zero = { ...emptyUsage(), cost: { ...emptyUsage().cost, totalFromProvider: flag } };
    addUsage(total, zero);
    addUsage(total, usage(true));
    expect(total.cost.totalFromProvider).toBe(flag);
  }
});

test("usage validation rejects malformed billing provenance", () => {
  expect(isUsage(usage(true))).toBe(true);
  expect(isUsage(usage())).toBe(true);
  expect(isUsage({ ...usage(), cost: { ...usage().cost, totalFromProvider: "true" } })).toBe(false);
});
