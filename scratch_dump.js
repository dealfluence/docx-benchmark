import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@usejunior/safe-docx"],
  });
  const mcpClient = new Client({ name: "dump-client", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
  const toolsResponse = await mcpClient.listTools();
  fs.writeFileSync("safe_docx_dump.json", JSON.stringify(toolsResponse.tools, null, 2));
  await mcpClient.close();
}

main().catch(console.error);
