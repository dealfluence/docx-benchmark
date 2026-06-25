import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import { loadToolConfigs, DEFAULT_TOOLS } from "./config.js";

describe("loadToolConfigs", () => {
  const tempFiles: string[] = [];
  const originalEnv = process.env.BENCHMARK_TOOLS;

  afterEach(() => {
    for (const f of tempFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    tempFiles.length = 0;
    if (originalEnv === undefined) delete process.env.BENCHMARK_TOOLS;
    else process.env.BENCHMARK_TOOLS = originalEnv;
  });

  it("falls back to bundled default tools when the config file is absent", () => {
    process.env.BENCHMARK_TOOLS = `./does-not-exist-${Date.now()}.json`;
    const tools = loadToolConfigs();
    expect(tools.map((t) => t.id).sort()).toEqual(Object.keys(DEFAULT_TOOLS).sort());
    const adeu = tools.find((t) => t.id === "adeu");
    expect(adeu?.command).toBe("npx");
    expect(adeu?.args).toContain("@adeu/mcp-server");
  });

  it("loads and resolves a custom mcpServers-style config", () => {
    const file = `./test-tools-${Date.now()}.json`;
    tempFiles.push(file);
    fs.writeFileSync(
      file,
      JSON.stringify({
        tools: {
          "my-tool": {
            displayName: "My Tool",
            command: "python",
            args: ["-m", "my_mcp"],
            argDefaults: { save: { allow_overwrite: true } },
          },
          "no-display": { command: "node", args: ["server.js"] },
        },
      }),
    );
    process.env.BENCHMARK_TOOLS = file;
    const tools = loadToolConfigs();

    const mine = tools.find((t) => t.id === "my-tool");
    expect(mine).toBeDefined();
    expect(mine?.displayName).toBe("My Tool");
    expect(mine?.command).toBe("python");
    expect(mine?.args).toEqual(["-m", "my_mcp"]);
    expect(mine?.argDefaults).toEqual({ save: { allow_overwrite: true } });

    // displayName defaults to the id when omitted.
    const noDisplay = tools.find((t) => t.id === "no-display");
    expect(noDisplay?.displayName).toBe("no-display");
  });

  it("throws on a structurally invalid config (missing command)", () => {
    const file = `./test-bad-tools-${Date.now()}.json`;
    tempFiles.push(file);
    fs.writeFileSync(file, JSON.stringify({ tools: { broken: { args: ["x"] } } }));
    process.env.BENCHMARK_TOOLS = file;
    expect(() => loadToolConfigs()).toThrow();
  });
});
