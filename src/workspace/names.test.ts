import { describe, expect, it } from "vitest";
import type { ModelObject } from "../../shared/model.ts";
import type { ModelIndex } from "../../shared/project.ts";
import { defaultName, isBlank, isDefaultName } from "./names";

const box = (fields: Partial<ModelObject>): ModelObject =>
  ({ id: "o1", name: "New app", description: "", ...fields }) as ModelObject;
const withLines = (...lines: [string, string][]): ModelIndex =>
  ({
    connections: new Map(lines.map(([fromId, toId], i) => [`c${i}`, { fromId, toId }])),
  }) as unknown as ModelIndex;

describe("defaultName", () => {
  it.each([
    ["app", "New app"],
    ["actor", "New actor"],
    ["store", "New store"],
    ["function", "new_function()"],
    ["table", "new_table"],
  ] as const)("names a new %s %s", (kind, name) => {
    expect(defaultName(kind)).toBe(name);
  });
});

describe("isDefaultName", () => {
  it.each([
    ["New app", true],
    ["New group", true],
    ["new_table", true],
    ["new_function()", true],
    ["New App", false],
    ["New two words", false],
    ["Billing", false],
    ["", false],
  ])("%j is %s", (name, expected) => {
    expect(isDefaultName(name)).toBe(expected);
  });
});

describe("isBlank", () => {
  it("is blank when still named by default with nothing on it", () => {
    expect(isBlank(withLines(), box({}))).toBe(true);
  });
  it("is blank with an empty name", () => {
    expect(isBlank(withLines(), box({ name: "  " }))).toBe(true);
  });
  it("is not blank once renamed", () => {
    expect(isBlank(withLines(), box({ name: "Billing" }))).toBe(false);
  });
  it("is not blank with a description", () => {
    expect(isBlank(withLines(), box({ description: "Takes payments" }))).toBe(false);
  });
  it("is not blank with columns", () => {
    expect(isBlank(withLines(), box({ columns: [{ name: "id", type: "int" }] }))).toBe(false);
  });
  it("is not blank with a connection either way", () => {
    expect(isBlank(withLines(["o1", "o2"]), box({}))).toBe(false);
    expect(isBlank(withLines(["o2", "o1"]), box({}))).toBe(false);
  });
  it("ignores other boxes' connections", () => {
    expect(isBlank(withLines(["o2", "o3"]), box({}))).toBe(true);
  });
});
