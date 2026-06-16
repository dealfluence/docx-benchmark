import { getEncoding } from "js-tiktoken";

const cl100k = getEncoding("cl100k_base");
const o200k = getEncoding("o200k_base");

export function countTokens(text: string, encoding: "cl100k_base" | "o200k_base"): number {
  if (encoding === "cl100k_base") {
    return cl100k.encode(text).length;
  } else if (encoding === "o200k_base") {
    return o200k.encode(text).length;
  }
  throw new Error(`Unsupported encoding: ${encoding}`);
}
