import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "node:fs";

try {
  if (fs.existsSync(".env")) {
    process.loadEnvFile();
  }
} catch (e) {}

const geminiKey = process.env.GEMINI_API_KEY;
const client = new GoogleGenerativeAI(geminiKey);

try {
  const models = await client.listModels();
  console.log("Models list successfully fetched!");
  for (const m of models.models || []) {
    console.log(m.name);
  }
} catch (e) {
  console.error("List models error:", e);
}
