import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

/**
 * Tools-under-test configuration.
 *
 * The benchmark is paradigm-agnostic: every competitor is an MCP server launched
 * over stdio. A tool is described in the familiar `mcpServers` shape (command +
 * args + env), plus a couple of benchmark-specific knobs:
 *   - `displayName`: human label injected into the system prompt.
 *   - `argDefaults`: per-tool-name argument defaults merged into every matching
 *     MCP tool call. This is how tool-specific quirks (e.g. safe-docx requiring
 *     `allow_overwrite: true` on `save`) stay in config instead of hardcoded.
 *
 * Anyone can drop their own MCP server into `benchmark.tools.json` and run the
 * suite against it with no code changes.
 */
export const ToolConfigSchema = z.object({
  displayName: z.string().optional(),
  command: z.string().min(1, "command is required"),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  argDefaults: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export const BenchmarkConfigSchema = z.object({
  tools: z.record(z.string(), ToolConfigSchema),
});

export type ToolConfigInput = z.infer<typeof ToolConfigSchema>;

/** A tool config with its id resolved from the keyed object and defaults applied. */
export interface ResolvedToolConfig {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  argDefaults?: Record<string, Record<string, unknown>>;
}

/**
 * Bundled default so the repo runs out-of-the-box without a config file.
 * Mirrors the two paradigms the suite originally compared.
 */
export const DEFAULT_TOOLS: Record<string, ToolConfigInput> = {
  adeu: {
    displayName: "Adeu MCP",
    command: "npx",
    args: ["-y", "@adeu/mcp-server", "--scope", "docx"],
  },
  "safe-docx": {
    displayName: "Safe Docx MCP",
    command: "npx",
    args: ["-y", "@usejunior/safe-docx"],
    argDefaults: { save: { allow_overwrite: true } },
  },
};

const DEFAULT_CONFIG_PATH = "./benchmark.tools.json";

function getConfigPathFromArgsOrEnv(): string {
  const idx = process.argv.indexOf("--tools");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  if (process.env.BENCHMARK_TOOLS) {
    return process.env.BENCHMARK_TOOLS;
  }
  return DEFAULT_CONFIG_PATH;
}

function resolveTools(tools: Record<string, ToolConfigInput>): ResolvedToolConfig[] {
  return Object.entries(tools).map(([id, t]) => ({
    id,
    displayName: t.displayName || id,
    command: t.command,
    args: t.args ?? [],
    env: t.env,
    argDefaults: t.argDefaults,
  }));
}

/**
 * Loads the tools-under-test configuration.
 *
 * Resolution order: `--tools <file>` flag, then `BENCHMARK_TOOLS` env, then
 * `./benchmark.tools.json`. If none exists, falls back to the bundled default
 * (adeu + safe-docx) and logs a notice. Validation failures throw with a clear
 * message rather than silently degrading.
 */
export function loadToolConfigs(): ResolvedToolConfig[] {
  const configPath = getConfigPathFromArgsOrEnv();
  const resolvedPath = path.resolve(configPath);

  if (!fs.existsSync(resolvedPath)) {
    console.log(
      `[INFO] No tools config found at '${configPath}'. Using bundled default tools (adeu, safe-docx).`,
    );
    return resolveTools(DEFAULT_TOOLS);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse tools config at '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = BenchmarkConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid tools config at '${resolvedPath}':\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }

  const toolIds = Object.keys(parsed.data.tools);
  if (toolIds.length === 0) {
    throw new Error(`Tools config at '${resolvedPath}' defines no tools under 'tools'.`);
  }

  console.log(
    `[INFO] Loaded ${toolIds.length} tool(s) from '${configPath}': ${toolIds.join(", ")}`,
  );
  return resolveTools(parsed.data.tools);
}
