import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadToolConfigs, ResolvedToolConfig } from "../config.js";

/**
 * Config-free healthcheck for the tools under test.
 *
 * Launches every tool declared in the active tools config (respecting
 * `--tools <file>` / `BENCHMARK_TOOLS`, same resolution as the benchmark) over
 * the SAME stdio MCP transport the benchmark uses, completes the handshake, and
 * lists the tools each server advertises. This verifies the launch wiring —
 * local-dev builds, published packages, relative paths, env — WITHOUT an API key
 * or a scored run, so you can confirm a config before spending model quota.
 *
 * Run:
 *   npm run tools:check                                    # default benchmark.tools.json
 *   npm run tools:check -- --tools benchmark.tools.local.json
 *
 * Exits non-zero if any tool fails to launch or list its tools.
 */

// Generous: a cold `uvx` first run downloads from PyPI and can take ~1 min.
const CONNECT_TIMEOUT_MS = 90_000;

/** Merge custom env onto the inherited process env (mirrors the benchmark's launcher). */
function buildEnv(extra?: Record<string, string>): Record<string, string> | undefined {
  if (!extra) return undefined;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  return { ...merged, ...extra };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

async function checkTool(tool: ResolvedToolConfig): Promise<boolean> {
  const launch = [tool.command, ...tool.args].join(" ");
  const started = Date.now();
  const transport = new StdioClientTransport({
    command: tool.command,
    args: tool.args,
    env: buildEnv(tool.env),
  });
  const client = new Client(
    { name: "adeu-benchmark-healthcheck", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
    );
    const info = (client.getServerVersion?.() ?? {}) as {
      name?: string;
      version?: string;
    };
    const { tools } = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      "listTools timed out",
    );
    const names = tools.map((t) => t.name).sort();
    const ms = Date.now() - started;

    console.log(`\n✅ ${tool.id}  —  ${tool.displayName}`);
    console.log(`   launch:  ${launch}`);
    console.log(`   server:  ${info.name ?? "?"} v${info.version ?? "?"}  (${ms}ms)`);
    console.log(`   tools (${names.length}): ${names.join(", ")}`);
    await client.close();
    return true;
  } catch (err) {
    console.log(`\n❌ ${tool.id}  —  ${tool.displayName}`);
    console.log(`   launch:  ${launch}`);
    console.log(`   ERROR:   ${err instanceof Error ? err.message : String(err)}`);
    try {
      await client.close();
    } catch {
      // already down
    }
    return false;
  }
}

async function main() {
  const tools = loadToolConfigs();
  console.log(`\n=== MCP tool healthcheck — connecting to ${tools.length} tool(s) ===`);
  console.log("(launch + tools/list only — no API key, no scored run)");

  // Sequential: keeps output readable and avoids racing multiple cold `uvx`
  // downloads. Healthcheck latency is not the point; clarity is.
  const results: boolean[] = [];
  for (const tool of tools) {
    results.push(await checkTool(tool));
  }

  const ok = results.filter(Boolean).length;
  const failed = results.length - ok;
  console.log(
    `\n=== ${ok}/${results.length} tool(s) healthy${failed ? ` — ${failed} FAILED` : ""} ===\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error during healthcheck:", err);
  process.exit(1);
});
