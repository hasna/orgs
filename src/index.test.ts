import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonOrgStore,
  createAgentSnapshot,
  normalizeGraphData,
  resolveDelegationTargets,
  validateGraphData,
  type OrgGraphData,
} from "./index.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "open-orgs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("open-orgs graph", () => {
  test("creates org graph records and exports a privacy-safe agent snapshot", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Open Tools", identityRef: { system: "open-identities", kind: "organization", id: "open-tools", metadata: { secret: "hidden" } } });
    const team = await store.createTeam({ orgId: org.id, name: "Maintainers" });
    const capability = await store.createCapability({ orgId: org.id, namespace: "repo", key: "review" });
    const lead = await store.createMember({
      orgId: org.id,
      kind: "agent",
      name: "Lead Agent",
      identityRef: { system: "open-identities", kind: "agent", id: "lead-agent", metadata: { token: "secret" } },
      teamIds: [team.id],
      capabilities: [`${capability.namespace}:${capability.key}`],
      responsibilities: ["Review incoming changes"],
    });
    const worker = await store.createMember({
      orgId: org.id,
      kind: "agent",
      name: "Worker Agent",
      identityRef: { system: "open-identities", kind: "agent", id: "worker-agent" },
      teamIds: [team.id],
    });
    await store.createMachine({
      orgId: org.id,
      name: "Linux Dev",
      machineRef: { system: "open-machines", kind: "machine", id: "linux-dev" },
      assignedMemberIds: [worker.id],
      dispatchTarget: { machine: "linux-dev", target: "work:agent.1", source: "manual", state: "idle" },
    });
    await store.createProject({
      orgId: org.id,
      name: "open-orgs",
      projectRef: { system: "open-projects", kind: "workspace", id: "open-orgs" },
      ownerMemberIds: [lead.id],
      capabilityIds: [capability.id],
    });
    await store.createRelationship({
      kind: "delegates_to",
      source: { kind: "member", id: lead.id },
      target: { kind: "member", id: worker.id },
      authority: "execute",
      scope: [{ capabilityId: capability.id }],
    });

    const snapshot = createAgentSnapshot(await store.exportData(), lead.id);
    expect(snapshot.identity.identityRef).toEqual({ system: "open-identities", kind: "agent", id: "lead-agent" });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.allowedDelegationTargets[0]).toMatchObject({
      memberId: worker.id,
      displayName: "Worker Agent",
      authority: "execute",
    });
    expect(snapshot.relatedProjects[0].name).toBe("open-orgs");
  });

  test("rejects active reporting cycles", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Cycle Org" });
    const one = await store.createMember({ orgId: org.id, kind: "agent", name: "One", identityRef: { system: "open-identities", kind: "agent", id: "one" } });
    const two = await store.createMember({ orgId: org.id, kind: "agent", name: "Two", identityRef: { system: "open-identities", kind: "agent", id: "two" } });
    await store.createRelationship({ kind: "reports_to", source: { kind: "member", id: one.id }, target: { kind: "member", id: two.id } });

    await expect(store.createRelationship({ kind: "reports_to", source: { kind: "member", id: two.id }, target: { kind: "member", id: one.id } })).rejects.toThrow(/Reporting cycle/);
  });

  test("validates capability namespace collisions", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Capability Org" });
    await store.createCapability({ orgId: org.id, namespace: "deploy", key: "prod" });
    await expect(store.createCapability({ orgId: org.id, namespace: "deploy", key: "prod", slug: "deploy-prod-two" })).rejects.toThrow(/Capability collision/);
  });

  test("resolves delegation targets with dispatch refusal semantics", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Resolve Org" });
    const lead = await store.createMember({ orgId: org.id, kind: "agent", name: "Lead", identityRef: { system: "open-identities", kind: "agent", id: "lead" } });
    const busy = await store.createMember({ orgId: org.id, kind: "agent", name: "Busy", identityRef: { system: "open-identities", kind: "agent", id: "busy" } });
    await store.createMachine({
      orgId: org.id,
      name: "Busy Machine",
      machineRef: { system: "open-machines", kind: "machine", id: "busy-machine" },
      assignedMemberIds: [busy.id],
      dispatchTarget: { machine: "busy-machine", target: "work:busy.1", state: "active" },
    });
    const relationship = await store.createRelationship({ kind: "delegates_to", source: { kind: "member", id: lead.id }, target: { kind: "member", id: busy.id }, authority: "execute" });

    const resolution = resolveDelegationTargets(await store.exportData(), { actor: lead.id });
    expect(resolution.targets).toHaveLength(0);
    expect(resolution.refused).toContainEqual({ relationshipId: relationship.id, target: busy.id, reason: "all known dispatch targets are active, stale, or unavailable" });
  });

  test("rejects relationship refs that point to the wrong declared kind", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Typed Org" });

    await expect(store.createRelationship({
      kind: "reports_to",
      source: { kind: "member", id: org.id },
      target: { kind: "member", id: org.id },
    })).rejects.toThrow(/wrong kind/);
  });

  test("rejects unsupported versions and invalid contract values", async () => {
    expect(() => normalizeGraphData({ version: 2 as 1 })).toThrow(/Unsupported org graph schema version/);
    const data = normalizeGraphData({
      version: 1,
      orgs: [{ id: "org_bad", slug: "bad", name: "Bad", metadata: {}, createdAt: "not-a-date", updatedAt: "2026-01-01T00:00:00.000Z" }],
      members: [{
        id: "mem_bad",
        slug: "bad-member",
        name: "Bad Member",
        displayName: "Bad Member",
        orgId: "org_bad",
        kind: "robot" as "agent",
        identityRef: { system: "open-identities", kind: "agent", id: "bad" },
        roleIds: [],
        teamIds: [],
        functionIds: [],
        capabilities: [],
        responsibilities: [],
        status: "busy" as "active",
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      relationships: [{
        id: "rel_bad",
        slug: "bad",
        kind: "bogus" as "custom",
        source: { kind: "member", id: "mem_bad" },
        target: { kind: "member", id: "mem_bad" },
        authority: "root" as "none",
        scope: [],
        allowedActions: [],
        deniedActions: [],
        validFrom: "also-bad",
        provenance: { source: "test", observedAt: "not-date" },
        confidence: 2,
        metadata: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    const codes = validateGraphData(data).issues.map((issue) => issue.code);
    expect(codes).toContain("invalid_date");
    expect(codes).toContain("invalid_member_kind");
    expect(codes).toContain("invalid_member_status");
    expect(codes).toContain("invalid_relationship_kind");
    expect(codes).toContain("invalid_relationship_authority");
    expect(codes).toContain("invalid_confidence");
  });

  test("honors project-scoped delegation relationships", async () => {
    const data = normalizeGraphData(JSON.parse(await readFile(join(process.cwd(), "examples", "machine-project-delegation.json"), "utf8")));
    const resolution = resolveDelegationTargets(data, { actor: "mem_triage_agent", project: "runtime" });
    expect(resolution.targets.map((target) => target.memberId)).toEqual(["mem_linux_worker"]);
  });

  test("strips hrefs, metadata, and dispatch details from snapshots", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Privacy Org" });
    const agent = await store.createMember({
      orgId: org.id,
      kind: "agent",
      name: "Private Agent",
      identityRef: { system: "open-identities", kind: "agent", id: "private-agent", href: "https://private.example/token", metadata: { token: "secret" } },
    });
    await store.createMachine({
      orgId: org.id,
      name: "Private Machine",
      machineRef: { system: "open-machines", kind: "machine", id: "private-machine", href: "ssh://secret-host" },
      assignedMemberIds: [agent.id],
      dispatchTarget: { machine: "private-machine", target: "secret-session:agent.1", state: "idle", detail: "secret payload" },
    });
    const snapshot = createAgentSnapshot(await store.exportData(), agent.id);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("private.example");
    expect(encoded).not.toContain("ssh://secret-host");
    expect(encoded).not.toContain("secret payload");
    expect(encoded).not.toContain("token");
  });

  test("uses role-derived capabilities during delegation resolution", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const org = await store.createOrg({ name: "Role Capability Org" });
    await store.createCapability({ id: "cap_review", orgId: org.id, namespace: "repo", key: "review" });
    const role = await store.createRole({ orgId: org.id, name: "Reviewer", requiredCapabilities: ["repo:review"] });
    const lead = await store.createMember({ orgId: org.id, kind: "agent", name: "Lead", identityRef: { system: "open-identities", kind: "agent", id: "lead" } });
    const reviewer = await store.createMember({ orgId: org.id, kind: "agent", name: "Reviewer", identityRef: { system: "open-identities", kind: "agent", id: "reviewer" }, roleIds: [role.id] });
    await store.createRelationship({ kind: "delegates_to", source: { kind: "member", id: lead.id }, target: { kind: "member", id: reviewer.id }, authority: "execute", scope: [{ capabilityId: "cap_review" }] });

    const resolution = resolveDelegationTargets(await store.exportData(), { actor: lead.id, capability: "repo:review" });
    expect(resolution.targets.map((target) => target.memberId)).toEqual([reviewer.id]);
  });

  test("audits mutations and quarantines malformed JSON", async () => {
    const storePath = join(dir, "orgs.json");
    const auditPath = join(dir, "audit.jsonl");
    const store = new JsonOrgStore({ filePath: storePath, auditPath });
    await store.createOrg({ name: "Audit Org" });
    expect(await readFile(auditPath, "utf8")).toContain("create:orgs");

    await writeFile(storePath, "{not-json", "utf8");
    const status = await store.status();
    expect(status.counts.orgs).toBe(0);
  });

  test("normalizes imported graph data with schema version one", async () => {
    const store = new JsonOrgStore({ filePath: join(dir, "orgs.json"), auditPath: join(dir, "audit.jsonl") });
    const graph = {
      version: 1,
      orgs: [{ id: "org_1", slug: "one", name: "One", metadata: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    } as OrgGraphData;
    await store.replaceAll(graph);
    expect((await store.exportData()).orgs[0].id).toBe("org_1");
  });
});
