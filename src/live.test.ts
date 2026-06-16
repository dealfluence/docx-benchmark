import { describe, it, expect } from "vitest";
import { runLiveBenchmark } from "./live.js";

describe("live benchmark module", () => {
  it("should export runLiveBenchmark function", () => {
    expect(runLiveBenchmark).toBeTypeOf("function");
  });
});
