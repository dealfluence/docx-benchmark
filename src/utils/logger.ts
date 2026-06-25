import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import { getTrialContext, trialTag } from "./trial-context.js";

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

      // Stamp every line with the active trial context so the shared .jsonl stays
      // attributable even when parallel trials interleave. Explicit fields already
      // present on the entry (e.g. a tool_step's own keys) are preserved.
      const trialCtx = getTrialContext();
      if (trialCtx) {
        logObj = {
          ...logObj,
          trialId: logObj.trialId ?? trialCtx.trialId,
          toolId: logObj.toolId ?? trialCtx.toolId,
          scenario: logObj.scenario ?? trialCtx.scenario,
          rep: logObj.rep ?? trialCtx.rep,
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

  // Prefix interleaved stdout with the active trial tag so a human can tell which
  // parallel trial each line belongs to. The tag is stdout-only; the .jsonl gets
  // the same attribution as structured fields instead.
  console.log = (...args: unknown[]) => {
    const formatted = util.format(...args);
    const tag = trialTag();
    originalLog(tag ? `${tag} ${formatted}` : formatted);
    writeToLogFiles("INFO", formatted);
  };

  console.warn = (...args: unknown[]) => {
    const formatted = util.format(...args);
    const tag = trialTag();
    originalWarn(tag ? `${tag} ${formatted}` : formatted);
    writeToLogFiles("WARN", formatted);
  };

  console.error = (...args: unknown[]) => {
    const formatted = util.format(...args);
    const tag = trialTag();
    originalError(tag ? `${tag} ${formatted}` : formatted);
    writeToLogFiles("ERROR", formatted);
  };

  // Return a cleanup / restore function. It resolves only once both log streams
  // have fully flushed to disk — callers must await it before process.exit, or the
  // tail of the .jsonl (final trial outcome + summary lines) can be lost to a
  // flush race, especially under high parallelism's heavier write bursts.
  return (): Promise<void> => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    const streams = [logFileStream, timestampedFileStream].filter(
      (s): s is fs.WriteStream => s !== null,
    );
    logFileStream = null;
    timestampedFileStream = null;
    return Promise.all(
      streams.map((s) => new Promise<void>((resolve) => s.end(() => resolve()))),
    ).then(() => undefined);
  };
}
