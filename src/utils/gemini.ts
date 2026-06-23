import { Type } from "@google/genai";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

export const GEMINI_TIMEOUT_MS = process.env.GEMINI_TIMEOUT_MS
  ? parseInt(process.env.GEMINI_TIMEOUT_MS, 10)
  : 180000;
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

export interface Schema {
  type?: string | Type;
  $schema?: string;
  additionalProperties?: boolean;
  anyOf?: Schema[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  description?: string;
  enum?: string[];
}

export function mapSchemaType(type: string): Type {
  return (Type as unknown as Record<string, Type>)[type.toUpperCase()] || Type.STRING;
}

/**
 * Normalizes tool schemas to conform with Google Gemini's uppercase SchemaType limitations
 * and flattens array properties declared with `anyOf`/`oneOf`.
 */
export function cleanSchema(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  const res: Schema = { ...schema };
  delete res.$schema;
  delete res.additionalProperties;

  const unionList = schema.anyOf || schema.oneOf;
  if (unionList) {
    const consolidatedProperties: Record<string, Schema> = {};
    const consolidatedRequired: string[] = [];
    let consolidatedType = "object";

    for (const sub of unionList) {
      const cleanedSub = cleanSchema(sub);
      if (cleanedSub) {
        if (cleanedSub.properties) {
          Object.assign(consolidatedProperties, cleanedSub.properties);
        }
        if (cleanedSub.required) {
          consolidatedRequired.push(...cleanedSub.required);
        }
        if (cleanedSub.type) {
          consolidatedType = cleanedSub.type as string;
        }
      }
    }

    res.type = consolidatedType;
    res.properties = consolidatedProperties;
    const uniqueConsolidatedRequired = Array.from(new Set(consolidatedRequired));
    const commonRequired = uniqueConsolidatedRequired.filter((reqField: string) =>
      unionList.every((sub: Schema) => sub.required?.includes(reqField)),
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
      const prop = schema.properties[key];
      if (prop) {
        res.properties[key] = cleanSchema(prop) as Schema;
      }
    }
  }
  if (schema.items) {
    res.items = cleanSchema(schema.items);
  }

  // Double-Serialization Guard: Explicitly declare array item parameters as structured
  // Type.OBJECT schemas when properties are present, preventing Gemini from falling back
  // to stringified JSON arrays during compilation.
  if (res.type === Type.ARRAY) {
    if (res.items) {
      if (res.items.properties || res.items.type === "object" || res.items.type === Type.OBJECT) {
        res.items.type = Type.OBJECT;
        if (!res.items.properties) {
          res.items.properties = {};
        }
      }
    } else {
      res.items = { type: Type.STRING };
    }
  }

  return res;
}
