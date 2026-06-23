import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";

let logFileStream: fs.WriteStream | null = null;
let timestampedFileStream: fs.WriteStream | null = null;

// ANSI escape code regex to strip terminal colors
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str: string): string {
  return str.replace(ansiRegex, "");
}

export interface FileLoggingOptions {
  staticPath?: string;
  resultsDir?: string;
}

export function setupFileLogging(options: FileLoggingOptions = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = options.resultsDir || "./results";
  const staticPath = options.staticPath || "./live_benchmark.jsonl";
  const timestampedPath = path.join(resultsDir, `${timestamp}.jsonl`);

  // Create results directory if it doesn't exist
  fs.mkdirSync(resultsDir, { recursive: true });

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  // Open write streams. 'w' flag overwrites/creates the static file for the latest run.
  logFileStream = fs.createWriteStream(staticPath, { flags: "w", encoding: "utf8" });
  timestampedFileStream = fs.createWriteStream(timestampedPath, { flags: "w", encoding: "utf8" });

  let isLogging = false;

  const writeToLogFiles = (level: "INFO" | "WARN" | "ERROR", rawMessage: string) => {
    if (isLogging) return;
    try {
      isLogging = true;

      const cleanMessage = stripAnsi(rawMessage).trim();
      if (!cleanMessage) return;

      // Check if the message is a JSON string (e.g. tool steps)
      let jsonEntry: Record<string, unknown> | null = null;
      if (cleanMessage.startsWith("{") && cleanMessage.endsWith("}")) {
        try {
          jsonEntry = JSON.parse(cleanMessage) as Record<string, unknown>;
        } catch {
          // Not valid JSON, process as plain text
        }
      }

      let logObj: Record<string, unknown>;
      if (jsonEntry) {
        logObj = {
          timestamp: (jsonEntry.timestamp as string) || new Date().toISOString(),
          level: "INFO",
          type: "tool_step",
          ...jsonEntry,
        };
      } else {
        // Parse leading timestamp if present (e.g. "[2026-06-23T15:03:00.000Z] ...")
        let logTimestamp = new Date().toISOString();
        let messageContent = cleanMessage;

        const tsMatch = cleanMessage.match(
          /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]/,
        );
        if (tsMatch) {
          logTimestamp = tsMatch[1];
          messageContent = cleanMessage.substring(tsMatch[0].length).trim();
        }

        // Determine log level
        let logMethodLevel: string = level;
        if (messageContent.startsWith("[INFO]")) {
          logMethodLevel = "INFO";
          messageContent = messageContent.substring(6).trim();
        } else if (messageContent.startsWith("[WARNING]")) {
          logMethodLevel = "WARN";
          messageContent = messageContent.substring(9).trim();
        } else if (messageContent.startsWith("[ERROR]")) {
          logMethodLevel = "ERROR";
          messageContent = messageContent.substring(7).trim();
        } else if (messageContent.startsWith("[API ERROR]")) {
          logMethodLevel = "ERROR";
          messageContent = messageContent.substring(11).trim();
        }

        logObj = {
          timestamp: logTimestamp,
          level: logMethodLevel,
          type: "text",
          message: messageContent,
        };
      }

      const line = JSON.stringify(logObj) + "\n";
      if (logFileStream) logFileStream.write(line);
      if (timestampedFileStream) timestampedFileStream.write(line);
    } catch (err) {
      originalError("[LOGGER ERROR] Failed to write JSON line:", err);
    } finally {
      isLogging = false;
    }
  };

  console.log = (...args: unknown[]) => {
    const formatted = util.format(...args);
    originalLog(...args);
    writeToLogFiles("INFO", formatted);
  };

  console.warn = (...args: unknown[]) => {
    const formatted = util.format(...args);
    originalWarn(...args);
    writeToLogFiles("WARN", formatted);
  };

  console.error = (...args: unknown[]) => {
    const formatted = util.format(...args);
    originalError(...args);
    writeToLogFiles("ERROR", formatted);
  };

  // Return a cleanup / restore function
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    if (logFileStream) {
      logFileStream.end();
      logFileStream = null;
    }
    if (timestampedFileStream) {
      timestampedFileStream.end();
      timestampedFileStream = null;
    }
  };
}
