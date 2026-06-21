import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DocumentObject } from "@adeu/core";
import { checkScenarioSuccess } from "../success.js";
import { getGoldenDocxPath } from "../baselines.js";

async function main() {
  const docPath = getGoldenDocxPath();
  const tempPath = path.resolve("./temp_test_safe_docx.docx");
  fs.copyFileSync(docPath, tempPath);

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@usejunior/safe-docx"],
  });

  const mcpClient = new Client(
    { name: "benchmark-test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  await mcpClient.connect(transport);

  console.log("1. Grepping for 'Seller'...");
  const grepRes = await mcpClient.callTool({
    name: "grep",
    arguments: {
      file_path: tempPath,
      pattern: "Seller",
    },
  });
  console.log("Grep output:", JSON.stringify(grepRes, null, 2));

  console.log("\n2. Replacing 'Seller' with 'Vendor'...");
  const replaceRes = await mcpClient.callTool({
    name: "replace_text",
    arguments: {
      file_path: tempPath,
      target_paragraph_id: "_bk_e23f91f98915",
      old_string: "Seller",
      new_string: "Vendor",
      instruction: "Update terminology to Vendor",
    },
  });
  console.log("Replace output:", JSON.stringify(replaceRes, null, 2));

  console.log("\n3. Saving...");
  const saveRes = await mcpClient.callTool({
    name: "save",
    arguments: {
      file_path: tempPath,
      save_to_local_path: tempPath,
      allow_overwrite: true,
    },
  });
  console.log("Save output:", JSON.stringify(saveRes, null, 2));

  // Check success
  const originalDoc = await DocumentObject.load(fs.readFileSync(docPath));
  const modifiedDoc = await DocumentObject.load(fs.readFileSync(tempPath));
  const isSuccess = checkScenarioSuccess("surgical-correction", originalDoc, modifiedDoc);
  console.log(`\nSuccess check result: ${isSuccess}`);

  await mcpClient.close();
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
}

main().catch(console.error);
