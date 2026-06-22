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

export function getTempDirPath(): string {
  return path.resolve("./temp");
}

export function clearTempDirectory(): void {
  const tempDir = getTempDirPath();
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });
}

export function getFixturesDirPath(): string {
  return path.resolve("./fixtures");
}

export function getFixturePath(org: string, filename: string): string {
  const fixturesDir = getFixturesDirPath();
  return path.join(fixturesDir, org, filename);
}
