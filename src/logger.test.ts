import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { setupFileLogging } from "./utils/logger.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Logger Utility", () => {
  let cleanup: (() => void) | null = null;
  const testFilesToCleanup: string[] = [];

  afterEach(async () => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    await delay(50);
    // Clean up test files if they exist
    for (const file of testFilesToCleanup) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    }
  });

  it("should successfully log text messages and structured tool steps sequentially", async () => {
    // Generate unique test paths for this run to avoid collisions
    const testFile1 = `./live_benchmark_test_1_${Date.now()}.jsonl`;
    const testFile2 = `./live_benchmark_test_2_${Date.now()}.jsonl`;
    testFilesToCleanup.push(testFile1, testFile2);

    // 1. Test standard logging
    cleanup = setupFileLogging({ staticPath: testFile1 });
    await delay(100); // Wait for the stream to open on disk

    console.log("[INFO] Testing standard info log message");
    console.warn("[WARNING] Testing warning message");
    console.error("[ERROR] Testing error message");

    cleanup();
    cleanup = null;
    await delay(100); // Wait for stream to flush and close

    expect(fs.existsSync(testFile1)).toBe(true);
    let content = fs.readFileSync(testFile1, "utf8").trim();
    let lines = content.split("\n").map((line) => JSON.parse(line));

    const log1 = lines.find((l) => l.message === "Testing standard info log message");
    expect(log1).toBeDefined();
    expect(log1.level).toBe("INFO");
    expect(log1.type).toBe("text");
    expect(log1.timestamp).toBeDefined();

    const log2 = lines.find((l) => l.message === "Testing warning message");
    expect(log2).toBeDefined();
    expect(log2.level).toBe("WARN");
    expect(log2.type).toBe("text");

    const log3 = lines.find((l) => l.message === "Testing error message");
    expect(log3).toBeDefined();
    expect(log3.level).toBe("ERROR");
    expect(log3.type).toBe("text");

    // 2. Test structured tool step logging
    cleanup = setupFileLogging({ staticPath: testFile2 });
    await delay(100); // Wait for stream to open

    const toolStepObj = {
      timestamp: "2026-06-23T18:00:00.000Z",
      turn: 2,
      paradigm: "safe-docx",
      tool: "modify",
      args: { target_text: "foo", new_text: "bar" },
      ok: true,
      resultBytes: 15,
      result: "success",
      elapsedMs: 345,
    };

    console.log(JSON.stringify(toolStepObj));

    cleanup();
    cleanup = null;
    await delay(100); // Wait for stream to flush and close

    expect(fs.existsSync(testFile2)).toBe(true);
    content = fs.readFileSync(testFile2, "utf8").trim();
    lines = content.split("\n").map((line) => JSON.parse(line));

    const log = lines.find((l) => l.tool === "modify");
    expect(log).toBeDefined();
    expect(log.timestamp).toBe("2026-06-23T18:00:00.000Z");
    expect(log.type).toBe("tool_step");
    expect(log.turn).toBe(2);
    expect(log.paradigm).toBe("safe-docx");
    expect(log.tool).toBe("modify");
    expect(log.args).toEqual({ target_text: "foo", new_text: "bar" });
    expect(log.ok).toBe(true);
    expect(log.elapsedMs).toBe(345);
  });
});
