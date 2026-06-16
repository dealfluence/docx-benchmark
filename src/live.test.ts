import { describe, it, expect } from "vitest";
import { runLiveBenchmark, validateXmlSyntax } from "./live.js";

describe("live benchmark module", () => {
  it("should export runLiveBenchmark function", () => {
    expect(runLiveBenchmark).toBeTypeOf("function");
  });

  it("should successfully validate correct XML syntax", () => {
    const validXml = `<document><body><p>Hello world</p></body></document>`;
    expect(validateXmlSyntax(validXml)).toBe(true);
  });

  it("should fail validation for incorrect XML syntax", () => {
    const invalidXml = `<document><body><p>Unclosed tag</body></document>`;
    expect(validateXmlSyntax(invalidXml)).toBe(false);
  });
});
