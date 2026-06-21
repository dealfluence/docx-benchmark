import { SchemaType } from "@google/generative-ai";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

export const GEMINI_TIMEOUT_MS = process.env.GEMINI_TIMEOUT_MS
  ? parseInt(process.env.GEMINI_TIMEOUT_MS, 10)
  : 60000;
export const MCP_CONNECT_TIMEOUT_MS = process.env.MCP_CONNECT_TIMEOUT_MS
  ? parseInt(process.env.MCP_CONNECT_TIMEOUT_MS, 10)
  : 30000;
export const MCP_TOOL_TIMEOUT_MS = process.env.MCP_TOOL_TIMEOUT_MS
  ? parseInt(process.env.MCP_TOOL_TIMEOUT_MS, 10)
  : 30000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errMsg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errMsg)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const DocumentChangeSchema = z.union([
  z.object({
    type: z.literal("modify"),
    target_text: z.string(),
    new_text: z.string(),
  }),
  z.object({
    type: z.literal("accept"),
    target_id: z.string(),
  }),
  z.object({
    type: z.literal("reject"),
    target_id: z.string(),
  }),
  z.object({
    type: z.literal("reply"),
    target_id: z.string(),
    text: z.string(),
  }),
]);

export const AdeuOutputSchema = z.array(DocumentChangeSchema);

export function mapSchemaType(type: string): SchemaType {
  return (SchemaType as any)[type.toUpperCase()] || SchemaType.STRING;
}

/**
 * Normalizes tool schemas to conform with Google Gemini's uppercase SchemaType limitations
 * and flattens array properties declared with `anyOf`/`oneOf`.
 */
export function cleanSchema(schema: any): any {
  if (!schema) return undefined;
  const res: any = { ...schema };
  delete res.$schema;
  delete res.additionalProperties;

  const unionList = schema.anyOf || schema.oneOf;
  if (unionList) {
    const consolidatedProperties: any = {};
    const consolidatedRequired: string[] = [];
    let consolidatedType = "object";

    for (const sub of unionList) {
      const cleanedSub = cleanSchema(sub);
      if (cleanedSub.properties) {
        Object.assign(consolidatedProperties, cleanedSub.properties);
      }
      if (cleanedSub.required) {
        consolidatedRequired.push(...cleanedSub.required);
      }
      if (cleanedSub.type) {
        consolidatedType = cleanedSub.type;
      }
    }

    res.type = consolidatedType;
    res.properties = consolidatedProperties;
    const commonRequired = consolidatedRequired.filter((reqField: string) =>
      unionList.every((sub: any) => sub.required?.includes(reqField)),
    );
    if (commonRequired.length > 0) {
      res.required = commonRequired;
    } else {
      delete res.required;
    }
    delete res.anyOf;
    delete res.oneOf;
  }

  if (typeof res.type === "string") {
    res.type = mapSchemaType(res.type);
  }
  if (schema.properties) {
    res.properties = {};
    for (const key of Object.keys(schema.properties)) {
      res.properties[key] = cleanSchema(schema.properties[key]);
    }
  }
  if (schema.items) {
    res.items = cleanSchema(schema.items);
  }
  return res;
}