import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.js";

let dir = "";
let storePath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-orgs-cli-"));
  storePath = join(dir, "orgs.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("orgs CLI", () => {
  test("adds records and exports a JSON snapshot with isolated --store", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "orgs", "add", "--name", "Open CLI"], { out: (text) => out.push(text), throwOnError: true });
    const org = JSON.parse(out.pop()!);

    await runCli([
      "--store",
      storePath,
      "--json",
      "agents",
      "add",
      "--org",
      org.id,
      "--name",
      "CLI Agent",
      "--identity",
      "agent:cli-agent",
      "--responsibility",
      "Keep command outputs stable",
    ], { out: (text) => out.push(text), throwOnError: true });
    const agent = JSON.parse(out.pop()!);

    await runCli(["--store", storePath, "--json", "snapshot", agent.id, "--format", "json"], { out: (text) => out.push(text), throwOnError: true });
    const snapshot = JSON.parse(out.pop()!);
    expect(snapshot.identity.displayName).toBe("CLI Agent");
    expect(snapshot.responsibilities).toEqual(["Keep command outputs stable"]);
  });

  test("dry-run import does not mutate the store", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "orgs", "add", "--name", "Original"], { out: (text) => out.push(text), throwOnError: true });
    const importPath = join(dir, "import.json");
    await writeFile(importPath, JSON.stringify({ version: 1, orgs: [{ id: "org_imported", slug: "imported", name: "Imported", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }, null, 2), "utf8");

    await runCli(["--store", storePath, "--json", "import", importPath, "--dry-run"], { out: (text) => out.push(text), throwOnError: true });
    const dryRun = JSON.parse(out.pop()!);
    expect(dryRun).toMatchObject({ dryRun: true, records: 1, valid: true });

    const stored = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored.orgs).toHaveLength(1);
    expect(stored.orgs[0].name).toBe("Original");
  });

  test("status reports metadata-only SQLite evidence when the JSON store is missing or empty", async () => {
    const out: string[] = [];
    const sqlitePath = join(dir, "orgs.db");
    await writeFile(sqlitePath, "SQLite format 3\u0000private payload marker", "utf8");

    await runCli(["--store", storePath, "--json", "status"], { out: (text) => out.push(text), throwOnError: true });
    const missingStatus = JSON.parse(out.pop()!);
    expect(missingStatus.warnings[0]).toMatchObject({ code: "legacy_sqlite_store_detected" });
    expect(missingStatus.files.alternateStores[0]).toMatchObject({
      kind: "sqlite",
      path: sqlitePath,
      exists: true,
      reason: "json_store_missing",
    });
    expect(JSON.stringify(missingStatus)).not.toContain("private payload marker");

    await writeFile(storePath, JSON.stringify({ version: 1 }, null, 2), "utf8");
    out.length = 0;
    await runCli(["--store", storePath, "status", "--verbose"], { out: (text) => out.push(text), throwOnError: true });
    const humanStatus = out.pop()!;
    expect(humanStatus).toContain("warning: SQLite orgs.db exists");
    expect(humanStatus).toContain("alternate store: sqlite");
    expect(humanStatus).toContain("json_store_empty");
    expect(humanStatus).not.toContain("private payload marker");
  });

  test("help keeps resolve aligned with the other commands", async () => {
    const out: string[] = [];
    await runCli(["--help"], { out: (text) => out.push(text), throwOnError: true });
    const help = out.pop()!;
    expect(help).toContain("  resolve [--actor <member>]");
    expect(help).not.toContain("\nresolve [--actor <member>]");
  });

  test("uses compact paginated human list output while preserving existing JSON list output", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "import", "examples/small-oss-org.json"], { out: (text) => out.push(text), throwOnError: true });

    out.length = 0;
    await runCli(["--store", storePath, "members", "list", "--limit", "1"], { out: (text) => out.push(text), throwOnError: true });
    const humanList = out.pop()!;
    expect(humanList).toContain("members: showing 1-1 of 2");
    expect(humanList).toContain("next cursor: 1");
    expect(humanList).toContain("members show <id>");
    expect(humanList).toContain("mem_review_agent");
    expect(humanList).not.toContain("identityRef");
    expect(humanList).not.toContain("createdAt");

    out.length = 0;
    await runCli(["--store", storePath, "--json", "members", "list"], { out: (text) => out.push(text), throwOnError: true });
    const fullJsonList = JSON.parse(out.pop()!);
    expect(Array.isArray(fullJsonList)).toBe(true);
    expect(fullJsonList).toHaveLength(2);
    expect(fullJsonList[0].identityRef.system).toBe("open-identities");

    out.length = 0;
    await runCli(["--store", storePath, "--json", "members", "list", "--limit", "1"], { out: (text) => out.push(text), throwOnError: true });
    const pagedJsonList = JSON.parse(out.pop()!);
    expect(pagedJsonList.records).toHaveLength(1);
    expect(pagedJsonList.page).toMatchObject({ total: 2, limit: 1, cursor: "0", nextCursor: "1" });
  });

  test("filters list output without dumping full records", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "import", "examples/small-oss-org.json"], { out: (text) => out.push(text), throwOnError: true });

    out.length = 0;
    await runCli(["--store", storePath, "members", "list", "--filter", "build"], { out: (text) => out.push(text), throwOnError: true });
    const filteredList = out.pop()!;
    expect(filteredList).toContain("1 matching of 2");
    expect(filteredList).toContain("mem_build_agent");
    expect(filteredList).not.toContain("mem_review_agent");
    expect(filteredList).not.toContain("identityRef");
  });

  test("shows compact human details and keeps JSON show as the full record", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "import", "examples/small-oss-org.json"], { out: (text) => out.push(text), throwOnError: true });

    out.length = 0;
    await runCli(["--store", storePath, "relationships", "show", "rel_review_delegates_build"], { out: (text) => out.push(text), throwOnError: true });
    const humanShow = out.pop()!;
    expect(humanShow.trim().startsWith("{")).toBe(false);
    expect(humanShow).toContain("relationship: delegates_to");
    expect(humanShow).toContain("source: member:mem_review_agent");
    expect(humanShow).toContain("hint: use --json");
    expect(humanShow).not.toContain("\"source\"");
    expect(humanShow).not.toContain("createdAt");

    out.length = 0;
    await runCli(["--store", storePath, "relationships", "show", "rel_review_delegates_build", "--verbose"], { out: (text) => out.push(text), throwOnError: true });
    expect(out.pop()!).toContain("created: 2026-01-01T00:00:00.000Z");

    out.length = 0;
    await runCli(["--store", storePath, "--json", "relationships", "show", "rel_review_delegates_build"], { out: (text) => out.push(text), throwOnError: true });
    const jsonShow = JSON.parse(out.pop()!);
    expect(jsonShow.source).toEqual({ kind: "member", id: "mem_review_agent" });
    expect(jsonShow.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("validates bad relationships through CLI", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "init"], { out: (text) => out.push(text), throwOnError: true });
    const data = JSON.parse(await readFile(storePath, "utf8"));
    data.relationships.push({
      id: "rel_bad",
      slug: "bad",
      kind: "reports_to",
      source: { kind: "member", id: "missing-one" },
      target: { kind: "member", id: "missing-two" },
      authority: "none",
      scope: [],
      allowedActions: [],
      deniedActions: [],
      provenance: { source: "test" },
      confidence: 1,
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");

    await runCli(["--store", storePath, "--json", "validate"], { out: (text) => out.push(text), throwOnError: true });
    const result = JSON.parse(out.pop()!);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue: { code: string }) => issue.code === "missing_source_node")).toBe(true);
  });

  test("creates relationships from imported org node refs", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "import", "examples/parent-orgs.json"], { out: (text) => out.push(text), throwOnError: true });
    await runCli([
      "--store",
      storePath,
      "--json",
      "relationships",
      "add",
      "--kind",
      "custom",
      "--from",
      "org:foundation",
      "--to",
      "org:project-group",
    ], { out: (text) => out.push(text), throwOnError: true });
    const relationship = JSON.parse(out.pop()!);
    expect(relationship.source.kind).toBe("org");
    expect(relationship.target.kind).toBe("org");
  });

  test("serializes JSON store writes across simultaneous CLI processes", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `Concurrent Org ${index}`);
    await Promise.all(names.map(async (name) => {
      const stdout = await runCliProcess(["--store", storePath, "--json", "orgs", "add", "--name", name]);
      expect(JSON.parse(stdout).name).toBe(name);
    }));

    const data = JSON.parse(await readFile(storePath, "utf8"));
    expect(data.orgs.map((org: { name: string }) => org.name).sort()).toEqual([...names].sort());
    expect(existsSync(`${storePath}.lock`)).toBe(false);
  });

  test("requires explicit identity refs for members and agents", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "orgs", "add", "--name", "Identity Org"], { out: (text) => out.push(text), throwOnError: true });
    const org = JSON.parse(out.pop()!);

    await expect(runCli(["--store", storePath, "agents", "add", "--org", org.id, "--name", "No Identity"], { out: () => undefined, throwOnError: true })).rejects.toThrow(/--identity is required/);
  });

  test("rejects invalid CLI enum values before writing", async () => {
    const out: string[] = [];
    await runCli(["--store", storePath, "--json", "orgs", "add", "--name", "Enum Org"], { out: (text) => out.push(text), throwOnError: true });
    const org = JSON.parse(out.pop()!);

    await expect(runCli(["--store", storePath, "members", "add", "--org", org.id, "--kind", "robot", "--name", "Robot", "--identity", "agent:robot"], { out: () => undefined, throwOnError: true })).rejects.toThrow(/invalid member kind/);
    await expect(runCli(["--store", storePath, "relationships", "add", "--kind", "bogus", "--from", `org:${org.id}`, "--to", `org:${org.id}`], { out: () => undefined, throwOnError: true })).rejects.toThrow(/invalid relationship kind/);
  });
});

async function runCliProcess(args: string[]): Promise<string> {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(`CLI process failed (${exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}
