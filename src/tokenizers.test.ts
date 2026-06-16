import { describe, it, expect } from "vitest";
import { countTokens } from "./tokenizers.js";

describe("tokenizers", () => {
  it("should count cl100k_base tokens correctly", () => {
    const text = "Hello world!";
    const count = countTokens(text, "cl100k_base");
    expect(count).toBeGreaterThan(0);
  });

  it("should count o200k_base tokens correctly", () => {
    const text = "Hello world!";
    const count = countTokens(text, "o200k_base");
    expect(count).toBeGreaterThan(0);
  });
});
