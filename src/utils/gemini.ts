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

export interface Schema {
  type?: string | SchemaType;
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

export function mapSchemaType(type: string): SchemaType {
  return (SchemaType as unknown as Record<string, SchemaType>)[type.toUpperCase()] || SchemaType.STRING;
}

const ChangesItemsSchema: Schema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      description: "The type of change: 'modify' (search-and-replace), 'accept' (finalize track change), 'reject' (revert track change), or 'reply' (reply to comment).",
      enum: ["modify", "accept", "reject", "reply"],
    },
    target_text: {
      type: "string",
      description: "For 'modify': the unique text/phrase in the original document to replace.",
    },
    new_text: {
      type: "string",
      description: "For 'modify': the new markdown-formatted text to insert.",
    },
    target_id: {
      type: "string",
      description: "For 'accept', 'reject', or 'reply': the target change ID (Chg:N) or comment ID (Com:N).",
    },
    text: {
      type: "string",
      description: "For 'reply': the text content of the reply.",
    },
  },
  required: ["type"],
};

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

  // Supply default items schema for array properties that do not have them
  if (res.type === SchemaType.ARRAY && !res.items) {
    if (res.description?.includes("List of changes")) {
      res.items = cleanSchema(ChangesItemsSchema);
    } else {
      res.items = { type: SchemaType.STRING };
    }
  }

  return res;
}