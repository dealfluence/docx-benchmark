// FILE: src/sanitize.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeDocxArg, resolveArgsToSessionDir } from "./loops.js";

describe("sanitizeDocxArg", () => {
  it("passes a clean .docx name through unchanged", () => {
    expect(sanitizeDocxArg("post-money-safe.docx")).toEqual({
      cleaned: "post-money-safe.docx",
      isDocx: true,
    });
  });

  it("strips trailing whitespace", () => {
    const r = sanitizeDocxArg("file.docx   ");
    expect(r.cleaned).toBe("file.docx");
    expect(r.isDocx).toBe(true);
  });

  it("strips a trailing dot", () => {
    const r = sanitizeDocxArg("file.docx.");
    expect(r.cleaned).toBe("file.docx");
    expect(r.isDocx).toBe(true);
  });

  it("strips wrapping double quotes", () => {
    const r = sanitizeDocxArg('"file.docx"');
    expect(r.cleaned).toBe("file.docx");
    expect(r.isDocx).toBe(true);
  });

  it("strips wrapping single quotes and backticks", () => {
    expect(sanitizeDocxArg("'file.docx'").cleaned).toBe("file.docx");
    expect(sanitizeDocxArg("`file.docx`").cleaned).toBe("file.docx");
  });

  it("strips a leading ./", () => {
    const r = sanitizeDocxArg("./file.docx");
    expect(r.cleaned).toBe("file.docx");
    expect(r.isDocx).toBe(true);
  });

  it("peels a combination of trailing junk", () => {
    const r = sanitizeDocxArg('  "file.docx" . ');
    expect(r.cleaned).toBe("file.docx");
    expect(r.isDocx).toBe(true);
  });

  it("strips a trailing comma", () => {
    expect(sanitizeDocxArg("file.docx,").cleaned).toBe("file.docx");
  });

  it("reports isDocx=false for non-docx strings and leaves them intact-ish", () => {
    expect(sanitizeDocxArg("just a summary sentence.").isDocx).toBe(false);
    expect(sanitizeDocxArg("report.pdf").isDocx).toBe(false);
  });

  it("does not misclassify a docx-substring that is not the extension", () => {
    expect(sanitizeDocxArg("file.docx.bak").isDocx).toBe(false);
  });
});

describe("resolveArgsToSessionDir with malformed names", () => {
  const sessionDir = "/tmp/session_abc";

  it("reroutes a malformed .docx arg into the session dir", () => {
    const out = resolveArgsToSessionDir({ filename: "post-money-safe.docx. " }, sessionDir);
    expect(out.filename).toBe("/tmp/session_abc/post-money-safe.docx");
  });

  it("strips a directory component via basename after cleaning", () => {
    const out = resolveArgsToSessionDir({ path: '"/some/abs/path/file.docx"' }, sessionDir);
    expect(out.path).toBe("/tmp/session_abc/file.docx");
  });

  it("leaves non-docx string args untouched", () => {
    const out = resolveArgsToSessionDir({ summary: "Filled in all fields." }, sessionDir);
    expect(out.summary).toBe("Filled in all fields.");
  });
});
