import { connectMcpClient } from "../loops.js";

async function main() {
  console.log("=== LISTING SAFE-DOCX TOOLS ===");
  try {
    const { tools } = await connectMcpClient("@usejunior/safe-docx", "safe-docx-list");
    for (const t of tools) {
      console.log(`- Tool: ${t.name}`);
      console.log(`  Description: ${t.description}`);
      console.log(`  Schema: ${JSON.stringify(t.inputSchema)}`);
    }
  } catch (err) {
    console.error("Error listing safe-docx tools:", err);
  }

  console.log("\n=== LISTING ADEU TOOLS ===");
  try {
    const { tools } = await connectMcpClient("@adeu/mcp-server", "adeu-list", ["--scope", "docx"]);
    for (const t of tools) {
      console.log(`- Tool: ${t.name}`);
      console.log(`  Description: ${t.description}`);
      console.log(`  Schema: ${JSON.stringify(t.inputSchema)}`);
    }
  } catch (err) {
    console.error("Error listing adeu tools:", err);
  }
}

main().catch((err) => console.error(err));
