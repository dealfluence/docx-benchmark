import * as fs from "node:fs";
import * as path from "node:path";

export function getGoldenDocxPath(): string {
  const candidates = [
    "./golden.docx",
    "../adeu/shared/fixtures/golden.docx",
    "/Users/mkorpela/workspace/adeu-benchmark/golden.docx",
    "./shared/fixtures/golden.docx",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return path.resolve(c);
    }
  }
  throw new Error("Could not locate golden.docx in any candidate paths");
}
