import { describe, it, expect } from "vitest";
import { main } from "./index.js";

describe("index CLI entry point", () => {
  it("should export main function", () => {
    expect(main).toBeTypeOf("function");
  });
});
