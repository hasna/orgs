import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
