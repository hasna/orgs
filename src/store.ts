import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ORG_GRAPH_SCHEMA_VERSION,
  type BaseRecord,
  type BusinessFunctionRecord,
  type CapabilityRecord,
  type CreateCapabilityInput,
  type CreateFunctionInput,
  type CreateMachineInput,
  type CreateMemberInput,
  type CreateOrgInput,
  type CreateProjectInput,
  type CreateRelationshipInput,
  type CreateRoleInput,
  type CreateTeamInput,
  type ExternalRef,
  type GraphCollectionName,
  type GraphNode,
  type GraphRecord,
  type JsonObject,
  type MachineRecord,
  type MemberRecord,
  type NodeRef,
  type OrgGraphData,
  type OrgNodeKind,
  type OrgRecord,
  type OrgStore,
  type OrgStoreStatus,
  type ProjectRecord,
  type RelationshipRecord,
  type RoleRecord,
  type TeamRecord,
  type ValidationIssue,
  type ValidationResult,
} from "./types.js";

export const OPEN_ORGS_STORE_ENV = "OPEN_ORGS_STORE" as const;
export const OPEN_ORGS_AUDIT_ENV = "OPEN_ORGS_AUDIT" as const;

const COLLECTIONS = [
  "orgs",
  "teams",
  "functions",
  "roles",
  "members",
  "projects",
  "machines",
  "capabilities",
  "relationships",
] as const satisfies readonly GraphCollectionName[];

const NODE_COLLECTIONS = [
  "orgs",
  "teams",
  "functions",
  "roles",
  "members",
  "projects",
  "machines",
  "capabilities",
] as const;

const NODE_KIND_TO_COLLECTION: Record<Exclude<OrgNodeKind, "external">, (typeof NODE_COLLECTIONS)[number]> = {
  org: "orgs",
  team: "teams",
  function: "functions",
  role: "roles",
  member: "members",
  project: "projects",
  machine: "machines",
  capability: "capabilities",
};

const RELATIONSHIP_KINDS = new Set([
  "reports_to",
  "delegates_to",
  "member_of",
  "owns",
  "stewards",
  "assigned_to",
  "requires_capability",
  "provides_capability",
  "policy_context",
  "actor_context",
  "uses",
  "custom",
]);

const RELATIONSHIP_AUTHORITIES = new Set(["none", "recommend", "execute", "approve", "admin"]);
const MEMBER_KINDS = new Set(["human", "agent", "service-account"]);
const MEMBER_STATUSES = new Set(["active", "inactive", "external", "archived"]);
const DISPATCH_TARGET_STATES = new Set(["idle", "active", "unknown", "stale", "unavailable"]);

const COLLECTION_TO_NODE_KIND: Record<(typeof NODE_COLLECTIONS)[number], Exclude<OrgNodeKind, "external">> = {
  orgs: "org",
  teams: "team",
  functions: "function",
  roles: "role",
  members: "member",
  projects: "project",
  machines: "machine",
  capabilities: "capability",
};

export interface JsonOrgStoreOptions {
  filePath?: string;
  auditPath?: string;
}

export function getOrgDataDir(): string {
  return join(homedir(), ".hasna", "orgs");
}

export function getOrgStorePath(): string {
  return process.env[OPEN_ORGS_STORE_ENV] || join(getOrgDataDir(), "orgs.json");
}

export function getOrgAuditPath(): string {
  return process.env[OPEN_ORGS_AUDIT_ENV] || join(getOrgDataDir(), "audit.jsonl");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createOrgId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Cannot create slug from empty value: ${value}`);
  return slug;
}

export class JsonOrgStore implements OrgStore {
  readonly filePath: string;
  readonly auditPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonOrgStoreOptions = {}) {
    this.filePath = options.filePath ?? getOrgStorePath();
    this.auditPath = options.auditPath ?? getOrgAuditPath();
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700).catch(() => undefined);
    await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.auditPath), 0o700).catch(() => undefined);
    if (!existsSync(this.filePath)) {
      await this.writeStore(defaultGraphData(), "init", "store");
    }
  }

  async status(): Promise<OrgStoreStatus> {
    const data = await this.readStore();
    return {
      service: "orgs",
      schemaVersion: "1.0",
      dataDir: dirname(this.filePath),
      env: {
        primary: OPEN_ORGS_STORE_ENV,
        audit: OPEN_ORGS_AUDIT_ENV,
        activeStoreOverride: Boolean(process.env[OPEN_ORGS_STORE_ENV]),
        activeAuditOverride: Boolean(process.env[OPEN_ORGS_AUDIT_ENV]),
      },
      files: {
        store: { path: this.filePath, exists: existsSync(this.filePath) },
        audit: { path: this.auditPath, exists: existsSync(this.auditPath) },
      },
      counts: countsFor(data),
      safety: {
        includesIdentityDocuments: false,
        includesSecrets: false,
        statusOutputIsMetadataOnly: true,
        snapshotsStripPrivateMetadata: true,
      },
    };
  }

  async exportData(): Promise<OrgGraphData> {
    return this.readStore();
  }

  async replaceAll(data: OrgGraphData): Promise<void> {
    return this.withMutation(async () => {
      const normalized = normalizeGraphData(data);
      const result = validateGraphData(normalized);
      if (!result.valid) {
        throw new Error(`Invalid org graph: ${result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join("; ")}`);
      }
      await this.writeStore(normalized, "replace-all", `${countsTotal(normalized)}`);
    });
  }

  async validate(): Promise<ValidationResult> {
    return validateGraphData(await this.readStore());
  }

  async createOrg(input: CreateOrgInput): Promise<OrgRecord> {
    return this.addRecord("orgs", createOrgRecord(input));
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    return this.addRecord("teams", createTeamRecord(input));
  }

  async createFunction(input: CreateFunctionInput): Promise<BusinessFunctionRecord> {
    return this.addRecord("functions", createFunctionRecord(input));
  }

  async createRole(input: CreateRoleInput): Promise<RoleRecord> {
    return this.addRecord("roles", createRoleRecord(input));
  }

  async createMember(input: CreateMemberInput): Promise<MemberRecord> {
    return this.addRecord("members", createMemberRecord(input));
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return this.addRecord("projects", createProjectRecord(input));
  }

  async createMachine(input: CreateMachineInput): Promise<MachineRecord> {
    return this.addRecord("machines", createMachineRecord(input));
  }

  async createCapability(input: CreateCapabilityInput): Promise<CapabilityRecord> {
    return this.addRecord("capabilities", createCapabilityRecord(input));
  }

  async createRelationship(input: CreateRelationshipInput): Promise<RelationshipRecord> {
    return this.addRecord("relationships", createRelationshipRecord(input));
  }

  async removeRelationship(target: string): Promise<boolean> {
    return this.withMutation(async () => {
      const data = await this.readStore();
      const next = data.relationships.filter((relationship) => !matchesRecord(relationship, target));
      if (next.length === data.relationships.length) return false;
      const nextData = { ...data, relationships: next };
      await this.writeStore(nextData, "remove-relationship", target);
      return true;
    });
  }

  async getNode(target: string, kinds?: OrgNodeKind[]): Promise<GraphNode | undefined> {
    return findNode(await this.readStore(), target, kinds);
  }

  async list(collection: GraphCollectionName): Promise<GraphRecord[]> {
    const data = await this.readStore();
    return [...data[collection]] as GraphRecord[];
  }

  private async addRecord<TCollection extends GraphCollectionName>(
    collection: TCollection,
    record: OrgGraphData[TCollection][number],
  ): Promise<OrgGraphData[TCollection][number]> {
    return this.withMutation(async () => {
      const data = await this.readStore();
      const existing = data[collection].find((candidate) => matchesRecord(candidate, record.id) || matchesRecord(candidate, record.slug));
      if (existing) throw new Error(`Duplicate ${collection} record: ${record.slug}`);
      const nextData = {
        ...data,
        [collection]: [...data[collection], record],
      } as OrgGraphData;
      const result = validateGraphData(nextData);
      if (!result.valid) {
        throw new Error(`Invalid ${collection} record: ${result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message).join("; ")}`);
      }
      await this.writeStore(nextData, `create:${collection}`, record.id);
      return record;
    });
  }

  private async readStore(): Promise<OrgGraphData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (!raw.trim()) return defaultGraphData();
      return normalizeGraphData(JSON.parse(raw) as Partial<OrgGraphData>);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return defaultGraphData();
      if (error instanceof SyntaxError) {
        const corruptPath = `${this.filePath}.corrupt.${Date.now()}`;
        await rename(this.filePath, corruptPath).catch(() => undefined);
        await this.writeAuditEvent("corrupt-quarantine", corruptPath);
        return defaultGraphData();
      }
      throw error;
    }
  }

  private async writeStore(data: OrgGraphData, action: string, target: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
    await this.writeAuditEvent(action, target);
  }

  private async writeAuditEvent(action: string, target: string): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
    await appendFile(
      this.auditPath,
      `${JSON.stringify({ action, target, at: nowIso(), store: this.filePath })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(this.auditPath, 0o600).catch(() => undefined);
  }

  private async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function createOrgStore(options?: JsonOrgStoreOptions): JsonOrgStore {
  return new JsonOrgStore(options);
}

export function defaultGraphData(): OrgGraphData {
  return {
    version: ORG_GRAPH_SCHEMA_VERSION,
    orgs: [],
    teams: [],
    functions: [],
    roles: [],
    members: [],
    projects: [],
    machines: [],
    capabilities: [],
    relationships: [],
  };
}

export function normalizeGraphData(input: Partial<OrgGraphData>): OrgGraphData {
  const version = (input as { version?: unknown }).version;
  if (version !== undefined && version !== ORG_GRAPH_SCHEMA_VERSION) {
    throw new Error(`Unsupported org graph schema version: ${String(version)}`);
  }
  return {
    version: ORG_GRAPH_SCHEMA_VERSION,
    orgs: (input.orgs ?? []).map(normalizeBaseRecord) as OrgRecord[],
    teams: (input.teams ?? []).map((record) => ({ ...normalizeBaseRecord(record), ...record, metadata: record.metadata ?? {}, functionIds: record.functionIds ?? [] })) as TeamRecord[],
    functions: (input.functions ?? []).map((record) => ({ ...normalizeBaseRecord(record), ...record, metadata: record.metadata ?? {}, capabilityIds: record.capabilityIds ?? [] })) as BusinessFunctionRecord[],
    roles: (input.roles ?? []).map((record) => ({
      ...normalizeBaseRecord(record),
      ...record,
      metadata: record.metadata ?? {},
      responsibilities: record.responsibilities ?? [],
      requiredCapabilities: record.requiredCapabilities ?? [],
    })) as RoleRecord[],
    members: (input.members ?? []).map((record) => ({
      ...normalizeBaseRecord(record),
      ...record,
      metadata: record.metadata ?? {},
      roleIds: record.roleIds ?? [],
      teamIds: record.teamIds ?? [],
      functionIds: record.functionIds ?? [],
      capabilities: record.capabilities ?? [],
      responsibilities: record.responsibilities ?? [],
      status: record.status ?? "active",
    })) as MemberRecord[],
    projects: (input.projects ?? []).map((record) => ({
      ...normalizeBaseRecord(record),
      ...record,
      metadata: record.metadata ?? {},
      ownerMemberIds: record.ownerMemberIds ?? [],
      ownerTeamIds: record.ownerTeamIds ?? [],
      stewardRoleIds: record.stewardRoleIds ?? [],
      capabilityIds: record.capabilityIds ?? [],
    })) as ProjectRecord[],
    machines: (input.machines ?? []).map((record) => ({
      ...normalizeBaseRecord(record),
      ...record,
      metadata: record.metadata ?? {},
      assignedMemberIds: record.assignedMemberIds ?? [],
      assignedTeamIds: record.assignedTeamIds ?? [],
      projectIds: record.projectIds ?? [],
      capabilityIds: record.capabilityIds ?? [],
    })) as MachineRecord[],
    capabilities: (input.capabilities ?? []).map((record) => ({
      ...normalizeBaseRecord(record),
      ...record,
      metadata: record.metadata ?? {},
      ownerMemberIds: record.ownerMemberIds ?? [],
      ownerTeamIds: record.ownerTeamIds ?? [],
      ownerRoleIds: record.ownerRoleIds ?? [],
      ownerFunctionIds: record.ownerFunctionIds ?? [],
      ownerProjectIds: record.ownerProjectIds ?? [],
    })) as CapabilityRecord[],
    relationships: (input.relationships ?? []).map(normalizeRelationshipRecord),
  };
}

export function createOrgRecord(input: CreateOrgInput): OrgRecord {
  return {
    ...baseRecord("org", input.name, input),
    parentOrgId: input.parentOrgId,
    identityRef: input.identityRef,
  };
}

export function createTeamRecord(input: CreateTeamInput): TeamRecord {
  return {
    ...baseRecord("team", input.name, input),
    orgId: input.orgId,
    parentTeamId: input.parentTeamId,
    functionIds: input.functionIds ?? [],
    identityRef: input.identityRef,
  };
}

export function createFunctionRecord(input: CreateFunctionInput): BusinessFunctionRecord {
  return {
    ...baseRecord("func", input.name, input),
    orgId: input.orgId,
    parentFunctionId: input.parentFunctionId,
    capabilityIds: input.capabilityIds ?? [],
  };
}

export function createRoleRecord(input: CreateRoleInput): RoleRecord {
  return {
    ...baseRecord("role", input.name, input),
    orgId: input.orgId,
    teamId: input.teamId,
    functionId: input.functionId,
    responsibilities: input.responsibilities ?? [],
    requiredCapabilities: input.requiredCapabilities ?? [],
  };
}

export function createMemberRecord(input: CreateMemberInput): MemberRecord {
  return {
    ...baseRecord("mem", input.name, input),
    orgId: input.orgId,
    kind: input.kind,
    identityRef: input.identityRef,
    displayName: input.displayName ?? input.name,
    roleIds: input.roleIds ?? [],
    teamIds: input.teamIds ?? [],
    functionIds: input.functionIds ?? [],
    capabilities: input.capabilities ?? [],
    responsibilities: input.responsibilities ?? [],
    status: input.status ?? "active",
  };
}

export function createProjectRecord(input: CreateProjectInput): ProjectRecord {
  return {
    ...baseRecord("proj", input.name, input),
    orgId: input.orgId,
    projectRef: input.projectRef,
    ownerMemberIds: input.ownerMemberIds ?? [],
    ownerTeamIds: input.ownerTeamIds ?? [],
    stewardRoleIds: input.stewardRoleIds ?? [],
    capabilityIds: input.capabilityIds ?? [],
  };
}

export function createMachineRecord(input: CreateMachineInput): MachineRecord {
  return {
    ...baseRecord("mach", input.name, input),
    orgId: input.orgId,
    machineRef: input.machineRef,
    assignedMemberIds: input.assignedMemberIds ?? [],
    assignedTeamIds: input.assignedTeamIds ?? [],
    projectIds: input.projectIds ?? [],
    capabilityIds: input.capabilityIds ?? [],
    dispatchTarget: input.dispatchTarget,
  };
}

export function createCapabilityRecord(input: CreateCapabilityInput): CapabilityRecord {
  const name = input.name ?? `${input.namespace}:${input.key}`;
  return {
    ...baseRecord("cap", name, input),
    orgId: input.orgId,
    namespace: requiredTrimmed(input.namespace, "namespace"),
    key: requiredTrimmed(input.key, "key"),
    ownerMemberIds: input.ownerMemberIds ?? [],
    ownerTeamIds: input.ownerTeamIds ?? [],
    ownerRoleIds: input.ownerRoleIds ?? [],
    ownerFunctionIds: input.ownerFunctionIds ?? [],
    ownerProjectIds: input.ownerProjectIds ?? [],
  };
}

export function createRelationshipRecord(input: CreateRelationshipInput): RelationshipRecord {
  const timestamp = nowIso();
  return {
    id: input.id ?? createOrgId("rel"),
    slug: input.slug ?? slugify(`${input.kind}-${input.source.kind}-${input.source.id}-${input.target.kind}-${input.target.id}`).slice(0, 96),
    kind: input.kind,
    source: input.source,
    target: input.target,
    authority: input.authority ?? "none",
    scope: input.scope ?? [],
    allowedActions: input.allowedActions ?? [],
    deniedActions: input.deniedActions ?? [],
    validFrom: input.validFrom,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    provenance: input.provenance ?? { source: "cli", observedAt: timestamp },
    confidence: input.confidence ?? 1,
    metadata: input.metadata ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function validateGraphData(data: OrgGraphData, now = nowIso()): ValidationResult {
  const issues: ValidationIssue[] = [];
  const allIds = new Map<string, OrgNodeKind | "relationship">();
  if ((data as { version?: unknown }).version !== ORG_GRAPH_SCHEMA_VERSION) {
    issues.push(error("unsupported_schema_version", `Unsupported org graph schema version: ${String((data as { version?: unknown }).version)}`));
  }

  for (const collection of COLLECTIONS) {
    const slugs = new Map<string, string>();
    for (const record of data[collection] as GraphRecord[]) {
      validateRecordDates(record, issues);
      if (allIds.has(record.id)) {
        issues.push(error("duplicate_id", `Duplicate id: ${record.id}`, record.id));
      }
      allIds.set(record.id, collection === "relationships" ? "relationship" : COLLECTION_TO_NODE_KIND[collection as (typeof NODE_COLLECTIONS)[number]]);
      const previousSlug = slugs.get(record.slug);
      if (previousSlug) issues.push(error("duplicate_slug", `Duplicate slug in ${collection}: ${record.slug}`, record.id));
      else slugs.set(record.slug, record.id);
    }
  }

  const nodeIds = new Set<string>();
  for (const collection of NODE_COLLECTIONS) {
    for (const record of data[collection]) nodeIds.add(record.id);
  }

  for (const org of data.orgs) {
    if (org.parentOrgId) requireId(data.orgs, org.parentOrgId, "missing_parent_org", `Missing parent org for ${org.id}`, issues, org.id);
    warnStaleRef(org.identityRef, issues, org.id);
  }
  detectParentCycles(data.orgs, "parentOrgId", "org_parent_cycle", issues);

  for (const team of data.teams) {
    requireId(data.orgs, team.orgId, "missing_team_org", `Missing org for team ${team.id}`, issues, team.id);
    if (team.parentTeamId) requireId(data.teams, team.parentTeamId, "missing_parent_team", `Missing parent team for ${team.id}`, issues, team.id);
    for (const functionId of team.functionIds) requireId(data.functions, functionId, "missing_team_function", `Missing function ${functionId} for team ${team.id}`, issues, team.id);
    warnStaleRef(team.identityRef, issues, team.id);
  }
  detectParentCycles(data.teams, "parentTeamId", "team_parent_cycle", issues);

  for (const func of data.functions) {
    requireId(data.orgs, func.orgId, "missing_function_org", `Missing org for function ${func.id}`, issues, func.id);
    if (func.parentFunctionId) requireId(data.functions, func.parentFunctionId, "missing_parent_function", `Missing parent function for ${func.id}`, issues, func.id);
    for (const capabilityId of func.capabilityIds) requireId(data.capabilities, capabilityId, "missing_function_capability", `Missing capability ${capabilityId} for function ${func.id}`, issues, func.id);
  }
  detectParentCycles(data.functions, "parentFunctionId", "function_parent_cycle", issues);

  for (const role of data.roles) {
    requireId(data.orgs, role.orgId, "missing_role_org", `Missing org for role ${role.id}`, issues, role.id);
    if (role.teamId) requireId(data.teams, role.teamId, "missing_role_team", `Missing team for role ${role.id}`, issues, role.id);
    if (role.functionId) requireId(data.functions, role.functionId, "missing_role_function", `Missing function for role ${role.id}`, issues, role.id);
    for (const capability of role.requiredCapabilities) requireCapability(data, role.orgId, capability, issues, role.id);
  }

  for (const member of data.members) {
    if (!MEMBER_KINDS.has(member.kind)) issues.push(error("invalid_member_kind", `Invalid member kind: ${String(member.kind)}`, member.id));
    if (!MEMBER_STATUSES.has(member.status)) issues.push(error("invalid_member_status", `Invalid member status: ${String(member.status)}`, member.id));
    requireId(data.orgs, member.orgId, "missing_member_org", `Missing org for member ${member.id}`, issues, member.id);
    for (const roleId of member.roleIds) requireId(data.roles, roleId, "missing_member_role", `Missing role ${roleId} for member ${member.id}`, issues, member.id);
    for (const teamId of member.teamIds) requireId(data.teams, teamId, "missing_member_team", `Missing team ${teamId} for member ${member.id}`, issues, member.id);
    for (const functionId of member.functionIds) requireId(data.functions, functionId, "missing_member_function", `Missing function ${functionId} for member ${member.id}`, issues, member.id);
    for (const capability of member.capabilities) requireCapability(data, member.orgId, capability, issues, member.id);
    warnStaleRef(member.identityRef, issues, member.id);
  }

  for (const project of data.projects) {
    requireId(data.orgs, project.orgId, "missing_project_org", `Missing org for project ${project.id}`, issues, project.id);
    for (const memberId of project.ownerMemberIds) requireId(data.members, memberId, "missing_project_owner", `Missing owner member ${memberId} for project ${project.id}`, issues, project.id);
    for (const teamId of project.ownerTeamIds) requireId(data.teams, teamId, "missing_project_team", `Missing owner team ${teamId} for project ${project.id}`, issues, project.id);
    for (const roleId of project.stewardRoleIds) requireId(data.roles, roleId, "missing_project_role", `Missing steward role ${roleId} for project ${project.id}`, issues, project.id);
    for (const capabilityId of project.capabilityIds) requireId(data.capabilities, capabilityId, "missing_project_capability", `Missing capability ${capabilityId} for project ${project.id}`, issues, project.id);
    warnStaleRef(project.projectRef, issues, project.id);
  }

  for (const machine of data.machines) {
    if (machine.dispatchTarget?.state && !DISPATCH_TARGET_STATES.has(machine.dispatchTarget.state)) {
      issues.push(error("invalid_dispatch_target_state", `Invalid dispatch target state: ${String(machine.dispatchTarget.state)}`, machine.id));
    }
    requireId(data.orgs, machine.orgId, "missing_machine_org", `Missing org for machine ${machine.id}`, issues, machine.id);
    for (const memberId of machine.assignedMemberIds) requireId(data.members, memberId, "missing_machine_member", `Missing assigned member ${memberId} for machine ${machine.id}`, issues, machine.id);
    for (const teamId of machine.assignedTeamIds) requireId(data.teams, teamId, "missing_machine_team", `Missing assigned team ${teamId} for machine ${machine.id}`, issues, machine.id);
    for (const projectId of machine.projectIds) requireId(data.projects, projectId, "missing_machine_project", `Missing project ${projectId} for machine ${machine.id}`, issues, machine.id);
    for (const capabilityId of machine.capabilityIds) requireId(data.capabilities, capabilityId, "missing_machine_capability", `Missing capability ${capabilityId} for machine ${machine.id}`, issues, machine.id);
    warnStaleRef(machine.machineRef, issues, machine.id);
  }

  const capabilityKeys = new Set<string>();
  for (const capability of data.capabilities) {
    requireId(data.orgs, capability.orgId, "missing_capability_org", `Missing org for capability ${capability.id}`, issues, capability.id);
    const uniqueKey = `${capability.orgId}:${capability.namespace}:${capability.key}`;
    if (capabilityKeys.has(uniqueKey)) issues.push(error("capability_collision", `Capability collision: ${uniqueKey}`, capability.id));
    capabilityKeys.add(uniqueKey);
    for (const memberId of capability.ownerMemberIds) requireId(data.members, memberId, "missing_capability_member", `Missing owner member ${memberId} for capability ${capability.id}`, issues, capability.id);
    for (const teamId of capability.ownerTeamIds) requireId(data.teams, teamId, "missing_capability_team", `Missing owner team ${teamId} for capability ${capability.id}`, issues, capability.id);
    for (const roleId of capability.ownerRoleIds) requireId(data.roles, roleId, "missing_capability_role", `Missing owner role ${roleId} for capability ${capability.id}`, issues, capability.id);
    for (const functionId of capability.ownerFunctionIds) requireId(data.functions, functionId, "missing_capability_function", `Missing owner function ${functionId} for capability ${capability.id}`, issues, capability.id);
    for (const projectId of capability.ownerProjectIds) requireId(data.projects, projectId, "missing_capability_project", `Missing owner project ${projectId} for capability ${capability.id}`, issues, capability.id);
  }

  for (const relationship of data.relationships) {
    if (!RELATIONSHIP_KINDS.has(relationship.kind)) issues.push(error("invalid_relationship_kind", `Invalid relationship kind: ${String(relationship.kind)}`, relationship.id));
    if (!RELATIONSHIP_AUTHORITIES.has(relationship.authority)) issues.push(error("invalid_relationship_authority", `Invalid relationship authority: ${String(relationship.authority)}`, relationship.id));
    validateNodeRef(data, relationship.source, nodeIds, issues, relationship.id, "source");
    validateNodeRef(data, relationship.target, nodeIds, issues, relationship.id, "target");
    if (!Number.isFinite(relationship.confidence) || relationship.confidence < 0 || relationship.confidence > 1) issues.push(error("invalid_confidence", `Relationship confidence must be between 0 and 1: ${relationship.id}`, relationship.id));
    validateOptionalDate(relationship.validFrom, "validFrom", relationship.id, issues);
    validateOptionalDate(relationship.expiresAt, "expiresAt", relationship.id, issues);
    validateOptionalDate(relationship.revokedAt, "revokedAt", relationship.id, issues);
    validateOptionalDate(relationship.provenance.observedAt, "provenance.observedAt", relationship.id, issues);
    if (isValidDate(relationship.validFrom) && isValidDate(relationship.expiresAt) && Date.parse(relationship.validFrom) > Date.parse(relationship.expiresAt)) {
      issues.push(error("invalid_relationship_lifetime", `Relationship validFrom is after expiresAt: ${relationship.id}`, relationship.id));
    }
    for (const scope of relationship.scope) {
      if (scope.orgId) requireId(data.orgs, scope.orgId, "missing_scope_org", `Missing scoped org ${scope.orgId}`, issues, relationship.id);
      if (scope.teamId) requireId(data.teams, scope.teamId, "missing_scope_team", `Missing scoped team ${scope.teamId}`, issues, relationship.id);
      if (scope.functionId) requireId(data.functions, scope.functionId, "missing_scope_function", `Missing scoped function ${scope.functionId}`, issues, relationship.id);
      if (scope.projectId) requireId(data.projects, scope.projectId, "missing_scope_project", `Missing scoped project ${scope.projectId}`, issues, relationship.id);
      if (scope.machineId) requireId(data.machines, scope.machineId, "missing_scope_machine", `Missing scoped machine ${scope.machineId}`, issues, relationship.id);
      if (scope.capabilityId) requireId(data.capabilities, scope.capabilityId, "missing_scope_capability", `Missing scoped capability ${scope.capabilityId}`, issues, relationship.id);
      warnStaleRef(scope.external, issues, relationship.id);
    }
    if (relationship.kind === "reports_to" && relationship.source.kind !== "member") {
      issues.push(error("invalid_reports_to_source", `reports_to source must be a member: ${relationship.id}`, relationship.id));
    }
    if (relationship.kind === "reports_to" && relationship.target.kind !== "member") {
      issues.push(error("invalid_reports_to_target", `reports_to target must be a member: ${relationship.id}`, relationship.id));
    }
    if (!isRelationshipActive(relationship, now)) {
      issues.push(warning("inactive_relationship", `Relationship is inactive, expired, or revoked: ${relationship.id}`, relationship.id));
    }
  }

  detectReportingCycles(data.relationships, issues, now);

  return { valid: !issues.some((issue) => issue.level === "error"), issues, counts: countsFor(data) };
}

export function findNode(data: OrgGraphData, target: string, kinds?: OrgNodeKind[]): GraphNode | undefined {
  const allowed = new Set(kinds ?? ["org", "team", "function", "role", "member", "project", "machine", "capability"]);
  const normalized = target.toLowerCase();
  for (const collection of NODE_COLLECTIONS) {
    const kind = COLLECTION_TO_NODE_KIND[collection];
    if (!allowed.has(kind)) continue;
    const record = data[collection].find((candidate) => {
      if (candidate.id === target || candidate.slug === normalized || candidate.slug === target) return true;
      return externalRefs(candidate).some((ref) => externalRefMatches(ref, target));
    });
    if (record) return record;
  }
  return undefined;
}

export function findRelationship(data: OrgGraphData, target: string): RelationshipRecord | undefined {
  return data.relationships.find((relationship) => matchesRecord(relationship, target));
}

export function nodeRefFor(node: GraphNode): NodeRef {
  return { kind: kindForNode(node), id: node.id };
}

export function kindForNode(node: GraphNode): Exclude<OrgNodeKind, "external"> {
  if ("projectRef" in node) return "project";
  if ("machineRef" in node) return "machine";
  if ("identityRef" in node && "kind" in node && "displayName" in node) return "member";
  if ("requiredCapabilities" in node) return "role";
  if ("functionIds" in node) return "team";
  if ("namespace" in node && "key" in node) return "capability";
  if ("capabilityIds" in node) return "function";
  return "org";
}

export function collectionForKind(kind: Exclude<OrgNodeKind, "external">): (typeof NODE_COLLECTIONS)[number] {
  return NODE_KIND_TO_COLLECTION[kind];
}

export function isRelationshipActive(relationship: RelationshipRecord, now = nowIso()): boolean {
  const current = Date.parse(now);
  if (relationship.revokedAt) return false;
  if (relationship.validFrom && Date.parse(relationship.validFrom) > current) return false;
  if (relationship.expiresAt && Date.parse(relationship.expiresAt) <= current) return false;
  return true;
}

function baseRecord(prefix: string, name: string, input: { id?: string; slug?: string; description?: string; metadata?: JsonObject }): BaseRecord {
  const timestamp = nowIso();
  const cleanName = requiredTrimmed(name, "name");
  return {
    id: input.id ?? createOrgId(prefix),
    slug: input.slug ?? slugify(cleanName),
    name: cleanName,
    description: input.description,
    metadata: input.metadata ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeBaseRecord<T extends Partial<BaseRecord>>(record: T): BaseRecord & T {
  const timestamp = record.createdAt ?? nowIso();
  return {
    ...record,
    id: requiredTrimmed(record.id, "id"),
    slug: record.slug ?? slugify(requiredTrimmed(record.name, "name")),
    name: requiredTrimmed(record.name, "name"),
    metadata: record.metadata ?? {},
    createdAt: timestamp,
    updatedAt: record.updatedAt ?? timestamp,
  };
}

function normalizeRelationshipRecord(record: Partial<RelationshipRecord>): RelationshipRecord {
  const timestamp = record.createdAt ?? nowIso();
  if (!record.kind) throw new Error("relationship kind is required");
  if (!record.source) throw new Error("relationship source is required");
  if (!record.target) throw new Error("relationship target is required");
  return {
    id: record.id ?? createOrgId("rel"),
    slug: record.slug ?? slugify(`${record.kind}-${record.source.kind}-${record.source.id}-${record.target.kind}-${record.target.id}`).slice(0, 96),
    kind: record.kind,
    source: record.source,
    target: record.target,
    authority: record.authority ?? "none",
    scope: record.scope ?? [],
    allowedActions: record.allowedActions ?? [],
    deniedActions: record.deniedActions ?? [],
    validFrom: record.validFrom,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    provenance: record.provenance ?? { source: "import", observedAt: timestamp },
    confidence: record.confidence ?? 1,
    metadata: record.metadata ?? {},
    createdAt: timestamp,
    updatedAt: record.updatedAt ?? timestamp,
  };
}

function countsFor(data: OrgGraphData): Record<GraphCollectionName, number> {
  const counts = {} as Record<GraphCollectionName, number>;
  for (const collection of COLLECTIONS) counts[collection] = data[collection].length;
  return counts;
}

function countsTotal(data: OrgGraphData): number {
  return COLLECTIONS.reduce((sum, collection) => sum + data[collection].length, 0);
}

function matchesRecord(record: Pick<BaseRecord, "id" | "slug">, target: string): boolean {
  return record.id === target || record.slug === target || record.slug === target.toLowerCase();
}

function requireId(records: Array<{ id: string }>, id: string, code: string, message: string, issues: ValidationIssue[], ownerId?: string): void {
  if (!records.some((record) => record.id === id)) issues.push(error(code, message, ownerId));
}

function validateNodeRef(data: OrgGraphData, ref: NodeRef, nodeIds: Set<string>, issues: ValidationIssue[], relationshipId: string, side: "source" | "target"): void {
  if (ref.kind === "external") {
    if (!ref.external) issues.push(error(`missing_${side}_external_ref`, `Relationship ${side} external ref is missing: ${relationshipId}`, relationshipId));
    else warnStaleRef(ref.external, issues, relationshipId);
    return;
  }
  const collection = NODE_KIND_TO_COLLECTION[ref.kind];
  const existsWithKind = collection !== undefined && data[collection].some((record) => record.id === ref.id);
  if (!existsWithKind) {
    const wrongKind = nodeIds.has(ref.id);
    issues.push(error(
      wrongKind ? `wrong_kind_${side}_node` : `missing_${side}_node`,
      wrongKind ? `Relationship ${side} node has wrong kind: ${ref.kind}:${ref.id}` : `Relationship ${side} node missing: ${ref.kind}:${ref.id}`,
      relationshipId,
    ));
  }
}

function requireCapability(data: OrgGraphData, orgId: string, target: string, issues: ValidationIssue[], ownerId?: string): void {
  const found = data.capabilities.some((capability) => capability.orgId === orgId && (capability.id === target || capability.slug === target || `${capability.namespace}:${capability.key}` === target));
  if (!found) issues.push(error("missing_required_capability", `Missing capability ${target} in org ${orgId}`, ownerId));
}

function detectParentCycles<T extends { id: string }>(records: T[], parentKey: keyof T, code: string, issues: ValidationIssue[]): void {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    const seen = new Set<string>();
    let cursor: T | undefined = record;
    while (cursor) {
      if (seen.has(cursor.id)) {
        issues.push(error(code, `Parent cycle detected at ${cursor.id}`, cursor.id));
        break;
      }
      seen.add(cursor.id);
      const parentId = cursor[parentKey] as string | undefined;
      cursor = parentId ? byId.get(parentId) : undefined;
    }
  }
}

function detectReportingCycles(relationships: RelationshipRecord[], issues: ValidationIssue[], now: string): void {
  const reportsTo = new Map<string, string>();
  for (const relationship of relationships) {
    if (relationship.kind !== "reports_to" || relationship.source.kind !== "member" || relationship.target.kind !== "member") continue;
    if (!isRelationshipActive(relationship, now)) continue;
    reportsTo.set(relationship.source.id, relationship.target.id);
  }
  for (const start of reportsTo.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor) {
      if (seen.has(cursor)) {
        issues.push(error("reporting_cycle", `Reporting cycle detected at member ${cursor}`, cursor));
        break;
      }
      seen.add(cursor);
      cursor = reportsTo.get(cursor);
    }
  }
}

function warnStaleRef(ref: ExternalRef | undefined, issues: ValidationIssue[], ownerId?: string): void {
  if (ref?.stale) issues.push(warning("stale_external_ref", `External ref is marked stale: ${ref.system}:${ref.kind}:${ref.id}`, ownerId));
  validateOptionalDate(ref?.observedAt, "externalRef.observedAt", ownerId, issues);
}

function validateRecordDates(record: Partial<BaseRecord> & { id?: string; createdAt?: string; updatedAt?: string; archivedAt?: string }, issues: ValidationIssue[]): void {
  validateOptionalDate(record.createdAt, "createdAt", record.id, issues);
  validateOptionalDate(record.updatedAt, "updatedAt", record.id, issues);
  validateOptionalDate(record.archivedAt, "archivedAt", record.id, issues);
}

function validateOptionalDate(value: string | undefined, field: string, ownerId: string | undefined, issues: ValidationIssue[]): void {
  if (value !== undefined && !isValidDate(value)) {
    issues.push(error("invalid_date", `Invalid ${field} date: ${value}`, ownerId));
  }
}

function isValidDate(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function externalRefs(node: GraphNode): ExternalRef[] {
  const refs: Array<ExternalRef | undefined> = [];
  if ("identityRef" in node) refs.push(node.identityRef);
  if ("projectRef" in node) refs.push(node.projectRef);
  if ("machineRef" in node) refs.push(node.machineRef);
  return refs.filter((ref): ref is ExternalRef => Boolean(ref));
}

function externalRefMatches(ref: ExternalRef, target: string): boolean {
  return ref.id === target || `${ref.system}:${ref.kind}:${ref.id}` === target || `${ref.system}:${ref.id}` === target;
}

function error(code: string, message: string, id?: string): ValidationIssue {
  return { level: "error", code, message, id };
}

function warning(code: string, message: string, id?: string): ValidationIssue {
  return { level: "warning", code, message, id };
}

function requiredTrimmed(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
