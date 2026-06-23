export const ORG_GRAPH_SCHEMA_VERSION = 1 as const;

export type JsonObject = Record<string, unknown>;

export type ExternalSystem =
  | "open-identities"
  | "open-projects"
  | "open-machines"
  | "open-sessions"
  | "open-dispatch"
  | "open-todos"
  | "open-events"
  | "open-actions"
  | "open-guardrails"
  | (string & {});

export interface ExternalRef {
  system: ExternalSystem;
  kind: string;
  id: string;
  label?: string;
  href?: string;
  observedAt?: string;
  stale?: boolean;
  metadata?: JsonObject;
}

export interface PublicExternalRef {
  system: ExternalSystem;
  kind: string;
  id: string;
  label?: string;
  href?: string;
  observedAt?: string;
  stale?: boolean;
}

export type OrgNodeKind =
  | "org"
  | "team"
  | "function"
  | "role"
  | "member"
  | "project"
  | "machine"
  | "capability"
  | "external";

export interface NodeRef {
  kind: OrgNodeKind;
  id: string;
  external?: ExternalRef;
}

export interface PublicNodeRef {
  kind: OrgNodeKind;
  id: string;
  external?: PublicExternalRef;
}

export interface BaseRecord {
  id: string;
  slug: string;
  name: string;
  description?: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface OrgRecord extends BaseRecord {
  parentOrgId?: string;
  identityRef?: ExternalRef;
}

export interface TeamRecord extends BaseRecord {
  orgId: string;
  parentTeamId?: string;
  functionIds: string[];
  identityRef?: ExternalRef;
}

export interface BusinessFunctionRecord extends BaseRecord {
  orgId: string;
  parentFunctionId?: string;
  capabilityIds: string[];
}

export interface RoleRecord extends BaseRecord {
  orgId: string;
  teamId?: string;
  functionId?: string;
  responsibilities: string[];
  requiredCapabilities: string[];
}

export type MemberKind = "human" | "agent" | "service-account";
export type MemberStatus = "active" | "inactive" | "external" | "archived";

export interface MemberRecord extends BaseRecord {
  orgId: string;
  kind: MemberKind;
  identityRef: ExternalRef;
  displayName: string;
  roleIds: string[];
  teamIds: string[];
  functionIds: string[];
  capabilities: string[];
  responsibilities: string[];
  status: MemberStatus;
}

export interface ProjectRecord extends BaseRecord {
  orgId: string;
  projectRef: ExternalRef;
  ownerMemberIds: string[];
  ownerTeamIds: string[];
  stewardRoleIds: string[];
  capabilityIds: string[];
}

export type DispatchTargetState = "idle" | "active" | "unknown" | "stale" | "unavailable";

export interface DispatchTargetRef {
  machine?: string;
  target?: string;
  source?: "open-dispatch" | "open-sessions" | "manual" | (string & {});
  state?: DispatchTargetState;
  lastSeenAt?: string;
  detail?: string;
}

export interface MachineRecord extends BaseRecord {
  orgId: string;
  machineRef: ExternalRef;
  assignedMemberIds: string[];
  assignedTeamIds: string[];
  projectIds: string[];
  capabilityIds: string[];
  dispatchTarget?: DispatchTargetRef;
}

export interface CapabilityRecord extends BaseRecord {
  orgId: string;
  namespace: string;
  key: string;
  ownerMemberIds: string[];
  ownerTeamIds: string[];
  ownerRoleIds: string[];
  ownerFunctionIds: string[];
  ownerProjectIds: string[];
}

export type RelationshipKind =
  | "reports_to"
  | "delegates_to"
  | "member_of"
  | "owns"
  | "stewards"
  | "assigned_to"
  | "requires_capability"
  | "provides_capability"
  | "policy_context"
  | "actor_context"
  | "uses"
  | "custom";

export type RelationshipAuthority = "none" | "recommend" | "execute" | "approve" | "admin";

export interface RelationshipScope {
  orgId?: string;
  teamId?: string;
  functionId?: string;
  projectId?: string;
  machineId?: string;
  capabilityId?: string;
  external?: ExternalRef;
}

export interface RelationshipProvenance {
  source: ExternalSystem | "cli" | "sdk" | "import" | "example" | (string & {});
  ref?: string;
  createdBy?: string;
  observedAt?: string;
}

export interface RelationshipRecord {
  id: string;
  slug: string;
  kind: RelationshipKind;
  source: NodeRef;
  target: NodeRef;
  authority: RelationshipAuthority;
  scope: RelationshipScope[];
  allowedActions: string[];
  deniedActions: string[];
  validFrom?: string;
  expiresAt?: string;
  revokedAt?: string;
  provenance: RelationshipProvenance;
  confidence: number;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface OrgGraphData {
  version: typeof ORG_GRAPH_SCHEMA_VERSION;
  orgs: OrgRecord[];
  teams: TeamRecord[];
  functions: BusinessFunctionRecord[];
  roles: RoleRecord[];
  members: MemberRecord[];
  projects: ProjectRecord[];
  machines: MachineRecord[];
  capabilities: CapabilityRecord[];
  relationships: RelationshipRecord[];
}

export type GraphCollectionName = keyof Omit<OrgGraphData, "version">;

export interface OrgStoreStatus {
  service: "orgs";
  schemaVersion: "1.0";
  dataDir: string;
  env: {
    primary: "OPEN_ORGS_STORE";
    audit: "OPEN_ORGS_AUDIT";
    activeStoreOverride: boolean;
    activeAuditOverride: boolean;
  };
  files: {
    store: { path: string; exists: boolean };
    audit: { path: string; exists: boolean };
  };
  counts: Record<GraphCollectionName, number>;
  safety: {
    includesIdentityDocuments: false;
    includesSecrets: false;
    statusOutputIsMetadataOnly: true;
    snapshotsStripPrivateMetadata: true;
  };
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  id?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  counts: Record<GraphCollectionName, number>;
}

export interface OrgStore {
  readonly filePath?: string;
  init(): Promise<void>;
  status(): Promise<OrgStoreStatus>;
  exportData(): Promise<OrgGraphData>;
  replaceAll(data: OrgGraphData): Promise<void>;
  validate(): Promise<ValidationResult>;
  createOrg(input: CreateOrgInput): Promise<OrgRecord>;
  createTeam(input: CreateTeamInput): Promise<TeamRecord>;
  createFunction(input: CreateFunctionInput): Promise<BusinessFunctionRecord>;
  createRole(input: CreateRoleInput): Promise<RoleRecord>;
  createMember(input: CreateMemberInput): Promise<MemberRecord>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  createMachine(input: CreateMachineInput): Promise<MachineRecord>;
  createCapability(input: CreateCapabilityInput): Promise<CapabilityRecord>;
  createRelationship(input: CreateRelationshipInput): Promise<RelationshipRecord>;
  removeRelationship(target: string): Promise<boolean>;
  getNode(target: string, kinds?: OrgNodeKind[]): Promise<GraphNode | undefined>;
  list(collection: GraphCollectionName): Promise<GraphRecord[]>;
}

export type GraphNode =
  | OrgRecord
  | TeamRecord
  | BusinessFunctionRecord
  | RoleRecord
  | MemberRecord
  | ProjectRecord
  | MachineRecord
  | CapabilityRecord;

export type GraphRecord = GraphNode | RelationshipRecord;

export interface CreateOrgInput {
  id?: string;
  slug?: string;
  name: string;
  description?: string;
  parentOrgId?: string;
  identityRef?: ExternalRef;
  metadata?: JsonObject;
}

export interface CreateTeamInput {
  id?: string;
  slug?: string;
  orgId: string;
  name: string;
  description?: string;
  parentTeamId?: string;
  functionIds?: string[];
  identityRef?: ExternalRef;
  metadata?: JsonObject;
}

export interface CreateFunctionInput {
  id?: string;
  slug?: string;
  orgId: string;
  name: string;
  description?: string;
  parentFunctionId?: string;
  capabilityIds?: string[];
  metadata?: JsonObject;
}

export interface CreateRoleInput {
  id?: string;
  slug?: string;
  orgId: string;
  name: string;
  description?: string;
  teamId?: string;
  functionId?: string;
  responsibilities?: string[];
  requiredCapabilities?: string[];
  metadata?: JsonObject;
}

export interface CreateMemberInput {
  id?: string;
  slug?: string;
  orgId: string;
  kind: MemberKind;
  name: string;
  displayName?: string;
  description?: string;
  identityRef: ExternalRef;
  roleIds?: string[];
  teamIds?: string[];
  functionIds?: string[];
  capabilities?: string[];
  responsibilities?: string[];
  status?: MemberStatus;
  metadata?: JsonObject;
}

export interface CreateProjectInput {
  id?: string;
  slug?: string;
  orgId: string;
  name: string;
  description?: string;
  projectRef: ExternalRef;
  ownerMemberIds?: string[];
  ownerTeamIds?: string[];
  stewardRoleIds?: string[];
  capabilityIds?: string[];
  metadata?: JsonObject;
}

export interface CreateMachineInput {
  id?: string;
  slug?: string;
  orgId: string;
  name: string;
  description?: string;
  machineRef: ExternalRef;
  assignedMemberIds?: string[];
  assignedTeamIds?: string[];
  projectIds?: string[];
  capabilityIds?: string[];
  dispatchTarget?: DispatchTargetRef;
  metadata?: JsonObject;
}

export interface CreateCapabilityInput {
  id?: string;
  slug?: string;
  orgId: string;
  namespace: string;
  key: string;
  name?: string;
  description?: string;
  ownerMemberIds?: string[];
  ownerTeamIds?: string[];
  ownerRoleIds?: string[];
  ownerFunctionIds?: string[];
  ownerProjectIds?: string[];
  metadata?: JsonObject;
}

export interface CreateRelationshipInput {
  id?: string;
  slug?: string;
  kind: RelationshipKind;
  source: NodeRef;
  target: NodeRef;
  authority?: RelationshipAuthority;
  scope?: RelationshipScope[];
  allowedActions?: string[];
  deniedActions?: string[];
  validFrom?: string;
  expiresAt?: string;
  revokedAt?: string;
  provenance?: RelationshipProvenance;
  confidence?: number;
  metadata?: JsonObject;
}

export interface AgentSnapshot {
  schemaVersion: "1.0";
  generatedAt: string;
  identity: {
    memberId: string;
    kind: MemberKind;
    displayName: string;
    identityRef: PublicExternalRef;
    status: MemberStatus;
  };
  org?: Pick<OrgRecord, "id" | "slug" | "name" | "parentOrgId">;
  teams: Array<Pick<TeamRecord, "id" | "slug" | "name" | "orgId">>;
  roles: Array<Pick<RoleRecord, "id" | "slug" | "name" | "responsibilities" | "requiredCapabilities">>;
  responsibilities: string[];
  capabilities: Array<Pick<CapabilityRecord, "id" | "slug" | "namespace" | "key" | "name">>;
  reportingPath: SnapshotActorRef[];
  allowedDelegationTargets: DelegationTarget[];
  relatedProjects: SnapshotProjectRef[];
  machineAssignments: SnapshotMachineRef[];
  policyContext: SnapshotPolicyRef[];
  warnings: string[];
}

export interface SnapshotActorRef {
  memberId: string;
  displayName: string;
  kind: MemberKind;
  identityRef: PublicExternalRef;
  authority?: RelationshipAuthority;
  relationshipId?: string;
}

export interface DelegationTarget extends SnapshotActorRef {
  scope: RelationshipScope[];
  capabilities: string[];
  dispatchTargets: DispatchTargetRef[];
}

export interface SnapshotProjectRef {
  projectId: string;
  name: string;
  projectRef: PublicExternalRef;
  roles: string[];
  capabilities: string[];
}

export interface SnapshotMachineRef {
  machineId: string;
  name: string;
  machineRef: PublicExternalRef;
  dispatchTarget?: DispatchTargetRef;
  projects: string[];
  capabilities: string[];
}

export interface SnapshotPolicyRef {
  relationshipId: string;
  target: PublicNodeRef;
  authority: RelationshipAuthority;
  scope: RelationshipScope[];
}

export interface ResolveDelegationOptions {
  actor?: string;
  capability?: string;
  team?: string;
  project?: string;
  machine?: string;
  now?: string;
}

export interface DelegationResolution {
  schemaVersion: "1.0";
  generatedAt: string;
  query: ResolveDelegationOptions;
  targets: DelegationTarget[];
  refused: Array<{
    target?: string;
    reason: string;
    relationshipId?: string;
  }>;
  warnings: string[];
}
