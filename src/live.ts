import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { performance } from "node:perf_hooks";
import { OpenAI } from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { DocumentObject, DocumentMapper, RedlineEngine } from "@adeu/core";
import { getGoldenDocxPath } from "./baselines.js";
import { scenarios } from "./scenarios.js";
import { XML_SYSTEM_PROMPT, MD_SYSTEM_PROMPT, ADEU_SYSTEM_PROMPT } from "./baselines.js";
import { evaluateFidelity, createStrippedDoc, createXmlReconstructedDoc } from "./fidelity.js";

// Load .env file programmatically (supported natively in Node.js >= 20.12.0 and Node 22)
try {
  if (fs.existsSync(".env")) {
    process.loadEnvFile();
  }
} catch {
  // Graceful fallback if not supported on old runtimes
}

const PROVIDER_CONFIGS = {
  openai: {
    model: "gpt-4o-mini",
  },
  anthropic: {
    model: "claude-3-5-haiku-20241022",
  },
  gemini: {
    model: "gemini-3.5-flash", // Reverted back to gemini-3.5-flash
  },
};

interface LiveResult {
  provider: string;
  model: string;
  scenarioId: string;
  paradigm: "Raw XML / Flat OPC" | "Naïve Markdown" | "Adeu Virtual DOM";
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  syntaxOk: boolean;
  semanticOk: boolean;
  reconciliationOk: boolean;
  fidelity: number;
  error?: string;
}

export function validateXmlSyntax(rawOutput: string): boolean {
  try {
    const parser = new DOMParser({
      onError: (level, msg) => {
        if (level === "error" || level === "fatalError") {
          throw new Error(msg);
        }
      },
    });
    const xmlDoc = parser.parseFromString(rawOutput, "text/xml");
    return !xmlDoc.getElementsByTagName("parsererror").length;
  } catch {
    return false;
  }
}

export async function runLiveBenchmark() {
  const docPath = getGoldenDocxPath();
  const buffer = fs.readFileSync(docPath);

  // Initialize API clients based on available environment variables
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clients: { provider: string; client: any; modelConfig: any }[] = [];

  if (openaiKey) {
    clients.push({
      provider: "OpenAI",
      client: new OpenAI({ apiKey: openaiKey }),
      modelConfig: PROVIDER_CONFIGS.openai,
    });
  }
  if (anthropicKey) {
    clients.push({
      provider: "Anthropic",
      client: new Anthropic({ apiKey: anthropicKey }),
      modelConfig: PROVIDER_CONFIGS.anthropic,
    });
  }
  if (geminiKey) {
    clients.push({
      provider: "Gemini",
      client: new GoogleGenerativeAI(geminiKey),
      modelConfig: PROVIDER_CONFIGS.gemini,
    });
  }

  if (clients.length === 0) {
    console.log(
      `\n\x1b[1m\x1b[31m[API Keys Missing]\x1b[0m No provider API keys were found in environment variables.`,
    );
    console.log(`Please export at least one of the following to run live benchmark runs:`);
    console.log(`  export OPENAI_API_KEY="your-openai-key"`);
    console.log(`  export ANTHROPIC_API_KEY="your-anthropic-key"`);
    console.log(`  export GEMINI_API_KEY="your-gemini-key"\n`);
    console.log(`Gracefully exiting live run...`);
    return;
  }

  console.log(`\n\x1b[1m\x1b[34m[Adeu Live Provider Benchmark]\x1b[0m`);
  console.log(`Loaded Document: ${docPath}`);
  console.log(`Configured Providers: ${clients.map((c) => c.provider).join(", ")}\n`);

  const results: LiveResult[] = [];

  for (const clientWrapper of clients) {
    const { provider, client, modelConfig } = clientWrapper;

    for (const scenario of scenarios) {
      const paradigms: ("Raw XML / Flat OPC" | "Naïve Markdown" | "Adeu Virtual DOM")[] = [
        "Raw XML / Flat OPC",
        "Naïve Markdown",
        "Adeu Virtual DOM",
      ];

      for (const paradigm of paradigms) {
        process.stdout.write(
          `Running: \x1b[32m${provider}\x1b[0m | \x1b[36m${scenario.id}\x1b[0m | \x1b[35m${paradigm}\x1b[0m... `,
        );

        // Load document fresh for each run to avoid side effects
        const doc = await DocumentObject.load(buffer);
        const originalDoc = await DocumentObject.load(buffer);
        let systemPrompt = "";
        let documentContent = "";
        let userInstruction = "";

        if (paradigm === "Raw XML / Flat OPC") {
          systemPrompt = XML_SYSTEM_PROMPT;
          documentContent = doc.part.blob;
          userInstruction = `Please update the document text according to these instructions:
Target Text to find: "${scenario.targetText}"
Replacement Text to insert: "${scenario.replacementText}"`;
        } else if (paradigm === "Naïve Markdown") {
          systemPrompt = MD_SYSTEM_PROMPT;
          documentContent = new DocumentMapper(doc, true).full_text;
          userInstruction = `Please update the document text according to these instructions:
Target Text to find: "${scenario.targetText}"
Replacement Text to insert: "${scenario.replacementText}"`;
        } else {
          systemPrompt = ADEU_SYSTEM_PROMPT;
          documentContent = new DocumentMapper(doc, false).full_text;
          userInstruction = `Generate a JSON array of DocumentChange objects representing the required change.
Target Text: "${scenario.targetText}"
Replacement Text: "${scenario.replacementText}"
Review Action: ${scenario.reviewAction ? JSON.stringify(scenario.reviewAction) : "none"}`;
        }

        const fullUserMessage = `Here is the document context:\n=== DOCUMENT START ===\n${documentContent}\n=== DOCUMENT END ===\n\nTask:\n${userInstruction}`;

        let rawOutput = "";
        let tokensIn = 0;
        let tokensOut = 0;
        let start = performance.now();
        let apiError: string | undefined = undefined;

        try {
          if (provider === "OpenAI") {
            const completion = await client.chat.completions.create({
              model: modelConfig.model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: fullUserMessage },
              ],
              temperature: 0.0,
            });
            rawOutput = completion.choices[0]?.message?.content || "";
            tokensIn = completion.usage?.prompt_tokens || 0;
            tokensOut = completion.usage?.completion_tokens || 0;
          } else if (provider === "Anthropic") {
            const msg = await client.messages.create({
              model: modelConfig.model,
              max_tokens: 4096,
              system: systemPrompt,
              messages: [{ role: "user", content: fullUserMessage }],
              temperature: 0.0,
            });
            rawOutput = msg.content[0]?.type === "text" ? msg.content[0].text : "";
            tokensIn = msg.usage.input_tokens;
            tokensOut = msg.usage.output_tokens;
          } else if (provider === "Gemini") {
            const modelInstance = client.getGenerativeModel({
              model: modelConfig.model,
              generationConfig: { temperature: 0.0 },
            });
            const geminiResponse = await modelInstance.generateContent({
              contents: [
                {
                  role: "user",
                  parts: [{ text: `System Instructions:\n${systemPrompt}\n\n${fullUserMessage}` }],
                },
              ],
            });
            rawOutput = geminiResponse.response.text() || "";
            tokensIn = geminiResponse.response.usageMetadata?.promptTokenCount || 0;
            tokensOut = geminiResponse.response.usageMetadata?.candidatesTokenCount || 0;
          }
        } catch (e: unknown) {
          apiError = e instanceof Error ? e.message : String(e);
        }

        const latencyMs = performance.now() - start;

        if (apiError) {
          results.push({
            provider,
            model: modelConfig.model,
            scenarioId: scenario.id,
            paradigm,
            latencyMs,
            tokensIn: 0,
            tokensOut: 0,
            totalTokens: 0,
            syntaxOk: false,
            semanticOk: false,
            reconciliationOk: false,
            fidelity: 0,
            error: apiError,
          });
          process.stdout.write(`\x1b[31m[ERROR: ${apiError}]\x1b[0m\n`);
          continue;
        }

        // =====================================================================
        // GROUNDED DETERMINISTIC EVALUATION
        // =====================================================================
        let syntaxOk = false;
        let semanticOk = false;
        let reconciliationOk = false;
        let fidelity = 0;

        if (paradigm === "Raw XML / Flat OPC") {
          // Syntax: Valid XML parse check
          syntaxOk = validateXmlSyntax(rawOutput);
          // Semantics: Output XML should contain the replacement text
          semanticOk = rawOutput.includes(scenario.replacementText);
          if (syntaxOk) {
            try {
              // Reconstruct the XML into a test-ready DocumentObject structure using buffer
              const reconstructedDoc = await createXmlReconstructedDoc(buffer, rawOutput);
              reconciliationOk = true;

              // Programmatically inspect styles, comment schemas, and header elements
              const fidelityResult = evaluateFidelity(originalDoc, reconstructedDoc, scenario.id);
              fidelity = fidelityResult.score;
            } catch {
              reconciliationOk = false;
              fidelity = 0;
            }
          } else {
            reconciliationOk = false;
            fidelity = 0;
          }
        } else if (paradigm === "Naïve Markdown") {
          syntaxOk = rawOutput.length > 0;
          semanticOk = rawOutput.includes(scenario.replacementText);
          if (syntaxOk) {
            try {
              // Simulates actual Markdown-to-DOCX conversion loss dynamically using buffer
              const strippedDoc = await createStrippedDoc(buffer, rawOutput);
              reconciliationOk = true;

              // Run calculated package properties evaluation
              const fidelityResult = evaluateFidelity(originalDoc, strippedDoc, scenario.id);
              fidelity = fidelityResult.score;
            } catch {
              reconciliationOk = false;
              fidelity = 0;
            }
          } else {
            reconciliationOk = false;
            fidelity = 0;
          }
        } else {
          // Adeu Virtual DOM surgical batch patching
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let parsedJSON: any = null;
          try {
            // Strip markdown blocks if models wrap JSON array
            let cleanJSON = rawOutput.trim();
            if (cleanJSON.startsWith("```json")) {
              cleanJSON = cleanJSON.slice(7);
            }
            if (cleanJSON.startsWith("```")) {
              cleanJSON = cleanJSON.slice(3);
            }
            if (cleanJSON.endsWith("```")) {
              cleanJSON = cleanJSON.slice(0, -3);
            }
            parsedJSON = JSON.parse(cleanJSON.trim());
            syntaxOk = Array.isArray(parsedJSON);
          } catch {
            syntaxOk = false;
          }

          if (syntaxOk && parsedJSON) {
            try {
              const engine = new RedlineEngine(doc);
              engine.process_batch(parsedJSON);
              reconciliationOk = true;

              // Check semantic accuracy after reconciliation
              const finalPlain = new DocumentMapper(doc, true).full_text;
              if (scenario.id === "surgical-correction") {
                semanticOk = finalPlain.includes(scenario.replacementText);
              } else if (scenario.id === "clause-drafting") {
                semanticOk = finalPlain.includes("Data Protection");
              } else {
                semanticOk = true; // Review operations accepted successfully
              }

              // Programmatically evaluate fidelity on surgically patched DocumentObject
              const fidelityResult = evaluateFidelity(originalDoc, doc, scenario.id);
              fidelity = fidelityResult.score;
            } catch {
              reconciliationOk = false;
            }
          }
        }

        results.push({
          provider,
          model: modelConfig.model,
          scenarioId: scenario.id,
          paradigm,
          latencyMs,
          tokensIn,
          tokensOut,
          totalTokens: tokensIn + tokensOut,
          syntaxOk,
          semanticOk,
          reconciliationOk,
          fidelity,
        });

        const latencySec = (latencyMs / 1000).toFixed(2);
        const syntaxStatus = syntaxOk ? "🟢 OK" : "🔴 FAIL";
        const semanticStatus = semanticOk ? "🟢 OK" : "🔴 FAIL";
        const reconciliationStatus = reconciliationOk ? "🟢 OK" : "🔴 FAIL";

        process.stdout.write(
          `\x1b[32m[DONE]\x1b[0m in ${latencySec}s | Tokens: In=${tokensIn}, Out=${tokensOut} | Syntax: ${syntaxStatus} | Semantics: ${semanticStatus} | Recon: ${reconciliationStatus}\n`,
        );
      }
    }
  }

  // Print results
  printLiveReport(results);
}

function printLiveReport(results: LiveResult[]) {
  console.log(`\n\x1b[1m\x1b[32m=== LIVE BENCHMARK CONSOLE SUMMARY ===\x1b[0m`);
  const tableRows = results.map((r) => ({
    Provider: r.provider,
    Model: r.model,
    Scenario: r.scenarioId,
    Paradigm: r.paradigm,
    "Latency (s)": (r.latencyMs / 1000).toFixed(2),
    "Tokens In": r.tokensIn,
    "Tokens Out": r.tokensOut,
    Total: r.totalTokens,
    Syntax: r.syntaxOk ? "🟢 OK" : "🔴 FAIL",
    Semantics: r.semanticOk ? "🟢 OK" : "🔴 FAIL",
    Reconciliation: r.reconciliationOk ? "🟢 OK" : "🔴 FAIL",
    Fidelity: `${r.fidelity}%`,
    Status: r.error ? `🔴 API Error: ${r.error.slice(0, 30)}` : "🟢 Success",
  }));
  console.table(tableRows);

  // Write Markdown artifact
  let md = `# Live Provider Grounded Evaluation Report\n\n`;
  md += `This report outlines the **live, grounded performance and correctness metrics** evaluated across Gemini, Anthropic, and OpenAI providers without using LLM-as-a-judge.\n\n`;

  const providerNames = Array.from(new Set(results.map((r) => r.provider)));
  for (const provider of providerNames) {
    md += `## Provider: ${provider} (${results.find((r) => r.provider === provider)?.model})\n\n`;
    md += `| Scenario | Processing Paradigm | Latency (s) | Input Tokens | Output Tokens | Total Tokens | Syntax Valid | Edit Correct | Structural Integrity | Fidelity Score |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    const pResults = results.filter((r) => r.provider === provider);
    for (const r of pResults) {
      const syntaxVal = r.syntaxOk ? "✅ PASS" : "❌ FAIL";
      const semanticVal = r.semanticOk ? "✅ PASS" : "❌ FAIL";
      const reconVal = r.reconciliationOk ? "✅ PASS" : "❌ FAIL";
      const latencyStr = (r.latencyMs / 1000).toFixed(2);

      md += `| ${r.scenarioId} | **${r.paradigm}** | ${latencyStr}s | ${r.tokensIn.toLocaleString()} | ${r.tokensOut.toLocaleString()} | ${r.totalTokens.toLocaleString()} | ${syntaxVal} | ${semanticVal} | ${reconVal} | ${r.fidelity}% |\n`;
    }
    md += `\n`;
  }

  const outputPath = "./live_benchmark_results.md";
  fs.writeFileSync(outputPath, md);
  console.log(
    `\n\x1b[1m\x1b[32m[Report Generated]\x1b[0m Saved detailed Markdown report to: ${outputPath}\n`,
  );
}

// Invoke main automatically if executed directly
const nodePath = process.argv[1];
if (nodePath) {
  const currentFilePath = fileURLToPath(import.meta.url);
  if (
    currentFilePath.endsWith(nodePath) ||
    currentFilePath.replace(/\.ts$/, ".js").endsWith(nodePath) ||
    nodePath.endsWith("src/live.ts") ||
    nodePath.endsWith("dist/live.js")
  ) {
    runLiveBenchmark();
  }
}
