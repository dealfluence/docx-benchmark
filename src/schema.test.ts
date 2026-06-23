import { describe, it, expect } from "vitest";
import { cleanSchema, Schema } from "./utils/gemini.js";
import { Type } from "@google/genai";

describe("Double-Serialization Guard Schema Tests", () => {
  it("should explicitly enforce Type.OBJECT on array item schemas with properties", () => {
    const inputSchema: Schema = {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            properties: {
              target_text: { type: "string" },
              new_text: { type: "string" },
            },
          },
        },
      },
    };

    const cleaned = cleanSchema(inputSchema);

    // Verify top-level property structure
    expect(cleaned).toBeDefined();
    expect(cleaned?.properties).toBeDefined();

    const changesSchema = cleaned?.properties?.changes;
    expect(changesSchema).toBeDefined();
    expect(changesSchema?.type).toBe(Type.ARRAY);

    // Verify that the array items have been explicitly typed as Type.OBJECT
    expect(changesSchema?.items).toBeDefined();
    expect(changesSchema?.items?.type).toBe(Type.OBJECT);
    expect(changesSchema?.items?.properties).toBeDefined();
  });

  it("should ensure Type.OBJECT arrays with missing properties block are initialized with properties", () => {
    const inputSchema: Schema = {
      type: "object",
      properties: {
        records: {
          type: "array",
          items: {
            type: "object",
          },
        },
      },
    };

    const cleaned = cleanSchema(inputSchema);
    const recordsSchema = cleaned?.properties?.records;

    expect(recordsSchema).toBeDefined();
    expect(recordsSchema?.type).toBe(Type.ARRAY);
    expect(recordsSchema?.items).toBeDefined();
    expect(recordsSchema?.items?.type).toBe(Type.OBJECT);
    expect(recordsSchema?.items?.properties).toEqual({});
  });
});
