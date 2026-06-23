import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeGraphData, validateGraphData } from "./index.js";

describe("bundled examples", () => {
  test("all example graphs validate", async () => {
    const examplesDir = join(process.cwd(), "examples");
    const files = (await readdir(examplesDir)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const data = normalizeGraphData(JSON.parse(await readFile(join(examplesDir, file), "utf8")));
      const result = validateGraphData(data);
      expect(result.issues.filter((issue) => issue.level === "error"), file).toEqual([]);
    }
  });
});
