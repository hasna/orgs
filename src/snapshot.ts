import { findNode, isRelationshipActive } from "./store.js";
import {
  type AgentSnapshot,
  type CapabilityRecord,
  type DelegationResolution,
  type DelegationTarget,
  type DispatchTargetRef,
  type ExternalRef,
  type GraphNode,
  type MachineRecord,
  type MemberRecord,
  type NodeRef,
  type OrgGraphData,
  type ProjectRecord,
  type PublicExternalRef,
  type PublicNodeRef,
  type RelationshipRecord,
  type RelationshipScope,
  type ResolveDelegationOptions,
  type RoleRecord,
  type SnapshotActorRef,
  type SnapshotMachineRef,
  type SnapshotPolicyRef,
  type SnapshotProjectRef,
  type TeamRecord,
} from "./types.js";

export function publicExternalRef(ref: ExternalRef): PublicExternalRef {
  return {
    system: ref.system,
    kind: ref.kind,
    id: ref.id,
    label: ref.label,
    observedAt: ref.observedAt,
    stale: ref.stale,
  };
}

export function publicNodeRef(ref: NodeRef): PublicNodeRef {
  return {
    kind: ref.kind,
    id: ref.id,
    external: ref.external ? publicExternalRef(ref.external) : undefined,
  };
}

export function createAgentSnapshot(data: OrgGraphData, target: string, now = new Date().toISOString()): AgentSnapshot {
  const member = requireMember(data, target);
  const org = data.orgs.find((item) => item.id === member.orgId);
  const teams = member.teamIds
    .map((id) => data.teams.find((team) => team.id === id))
    .filter((team): team is TeamRecord => Boolean(team));
  const roles = member.roleIds
    .map((id) => data.roles.find((role) => role.id === id))
    .filter((role): role is RoleRecord => Boolean(role));
  const capabilities = resolveMemberCapabilities(data, member, roles);
  const responsibilities = unique([
    ...member.responsibilities,
    ...roles.flatMap((role) => role.responsibilities),
  ]);
  const reportingPath = buildReportingPath(data, member, now);
  const allowedDelegationTargets = resolveDelegationTargets(data, { actor: member.id, now }).targets;
  const relatedProjects = buildRelatedProjects(data, member, roles);
  const machineAssignments = buildMachineAssignments(data, member, teams, relatedProjects);
  const policyContext = buildPolicyContext(data, member, now);
  const warnings = collectSnapshotWarnings(member, relatedProjects, machineAssignments, allowedDelegationTargets);

  return {
    schemaVersion: "1.0",
    generatedAt: now,
    identity: {
      memberId: member.id,
      kind: member.kind,
      displayName: member.displayName,
      identityRef: publicExternalRef(member.identityRef),
      status: member.status,
    },
    org: org ? { id: org.id, slug: org.slug, name: org.name, parentOrgId: org.parentOrgId } : undefined,
    teams: teams.map((team) => ({ id: team.id, slug: team.slug, name: team.name, orgId: team.orgId })),
    roles: roles.map((role) => ({
      id: role.id,
      slug: role.slug,
      name: role.name,
      responsibilities: role.responsibilities,
      requiredCapabilities: role.requiredCapabilities,
    })),
    responsibilities,
    capabilities: capabilities.map((capability) => ({
      id: capability.id,
      slug: capability.slug,
      namespace: capability.namespace,
      key: capability.key,
      name: capability.name,
    })),
    reportingPath,
    allowedDelegationTargets,
    relatedProjects,
    machineAssignments,
    policyContext,
    warnings,
  };
}

export function resolveDelegationTargets(data: OrgGraphData, options: ResolveDelegationOptions = {}): DelegationResolution {
  const now = options.now ?? new Date().toISOString();
  const actor = options.actor ? requireMember(data, options.actor) : undefined;
  const warnings: string[] = [];
  const refused: DelegationResolution["refused"] = [];
  const targets: DelegationTarget[] = [];

  const explicitRelationships = data.relationships.filter((relationship) => {
    if (relationship.kind !== "delegates_to") return false;
    if (actor && (relationship.source.kind !== "member" || relationship.source.id !== actor.id)) return false;
    return true;
  });

  for (const relationship of explicitRelationships) {
    if (!isRelationshipActive(relationship, now)) {
      refused.push({ relationshipId: relationship.id, reason: "relationship is inactive, expired, or revoked" });
      continue;
    }
    if (relationship.target.kind !== "member") {
      refused.push({ relationshipId: relationship.id, target: relationship.target.id, reason: "delegation target is not a member" });
      continue;
    }
    const target = data.members.find((member) => member.id === relationship.target.id);
    if (!target) {
      refused.push({ relationshipId: relationship.id, target: relationship.target.id, reason: "delegation target member is missing" });
      continue;
    }
    const targetRecord = buildDelegationTarget(data, target, relationship);
    const filterReason = delegationFilterReason(data, target, targetRecord, options);
    if (filterReason) {
      refused.push({ relationshipId: relationship.id, target: target.id, reason: filterReason });
      continue;
    }
    targets.push(targetRecord);
  }

  if (!actor && targets.length === 0 && options.capability) {
    const capability = findCapability(data, options.capability);
    if (capability) {
      for (const memberId of capability.ownerMemberIds) {
        const member = data.members.find((item) => item.id === memberId);
        if (!member) continue;
        const target = buildDelegationTarget(data, member);
        const filterReason = delegationFilterReason(data, member, target, options);
        if (filterReason) refused.push({ target: member.id, reason: filterReason });
        else targets.push(target);
      }
    } else {
      warnings.push(`capability not found: ${options.capability}`);
    }
  }

  for (const target of targets) {
    if (target.dispatchTargets.some((dispatch) => dispatch.state === "stale" || dispatch.state === "unavailable")) {
      warnings.push(`target ${target.memberId} has stale or unavailable dispatch evidence`);
    }
    if (target.dispatchTargets.length === 0) {
      warnings.push(`target ${target.memberId} has no dispatch target evidence`);
    }
  }

  return {
    schemaVersion: "1.0",
    generatedAt: now,
    query: { ...options, now },
    targets: dedupeDelegationTargets(targets),
    refused,
    warnings: unique(warnings),
  };
}

export function formatAgentSnapshotMarkdown(snapshot: AgentSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${snapshot.identity.displayName}`);
  lines.push("");
  lines.push(`- Identity: ${snapshot.identity.identityRef.system}:${snapshot.identity.identityRef.kind}:${snapshot.identity.identityRef.id}`);
  lines.push(`- Kind: ${snapshot.identity.kind}`);
  lines.push(`- Status: ${snapshot.identity.status}`);
  if (snapshot.org) lines.push(`- Org: ${snapshot.org.name}`);
  if (snapshot.teams.length > 0) lines.push(`- Teams: ${snapshot.teams.map((team) => team.name).join(", ")}`);
  if (snapshot.roles.length > 0) lines.push(`- Roles: ${snapshot.roles.map((role) => role.name).join(", ")}`);
  lines.push("");
  lines.push("## Responsibilities");
  lines.push(...listLines(snapshot.responsibilities));
  lines.push("");
  lines.push("## Capabilities");
  lines.push(...listLines(snapshot.capabilities.map((capability) => `${capability.namespace}:${capability.key}`)));
  lines.push("");
  lines.push("## Reporting Path");
  lines.push(...listLines(snapshot.reportingPath.map((actor) => `${actor.displayName} (${actor.kind})`)));
  lines.push("");
  lines.push("## Delegation Targets");
  lines.push(...listLines(snapshot.allowedDelegationTargets.map((target) => {
    const dispatch = target.dispatchTargets.map((item) => [item.machine, item.target].filter(Boolean).join(":")).filter(Boolean);
    return `${target.displayName} (${target.kind}, ${target.authority ?? "none"})${dispatch.length ? ` via ${dispatch.join(", ")}` : ""}`;
  })));
  lines.push("");
  lines.push("## Related Projects");
  lines.push(...listLines(snapshot.relatedProjects.map((project) => `${project.name} [${project.roles.join(", ") || "related"}]`)));
  lines.push("");
  lines.push("## Machine Assignments");
  lines.push(...listLines(snapshot.machineAssignments.map((machine) => `${machine.name}${machine.dispatchTarget?.target ? ` (${machine.dispatchTarget.target})` : ""}`)));
  if (snapshot.policyContext.length > 0) {
    lines.push("");
    lines.push("## Policy Context");
    lines.push(...listLines(snapshot.policyContext.map((policy) => `${policy.target.kind}:${policy.target.id} (${policy.authority})`)));
  }
  if (snapshot.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push(...listLines(snapshot.warnings));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function requireMember(data: OrgGraphData, target: string): MemberRecord {
  const node = findNode(data, target, ["member"]);
  if (!node || !("displayName" in node)) throw new Error(`Member not found: ${target}`);
  return node;
}

function buildReportingPath(data: OrgGraphData, member: MemberRecord, now: string): SnapshotActorRef[] {
  const path: SnapshotActorRef[] = [];
  const seen = new Set<string>();
  let cursor = member;
  while (!seen.has(cursor.id)) {
    seen.add(cursor.id);
    const relationship = data.relationships.find((item) => (
      item.kind === "reports_to" &&
      item.source.kind === "member" &&
      item.source.id === cursor.id &&
      item.target.kind === "member" &&
      isRelationshipActive(item, now)
    ));
    if (!relationship) break;
    const manager = data.members.find((item) => item.id === relationship.target.id);
    if (!manager) break;
    path.push(actorRef(manager, relationship));
    cursor = manager;
  }
  return path;
}

function buildDelegationTarget(data: OrgGraphData, member: MemberRecord, relationship?: RelationshipRecord): DelegationTarget {
  const teamIds = new Set(member.teamIds);
  const machines = data.machines.filter((machine) => (
    machine.assignedMemberIds.includes(member.id) ||
    machine.assignedTeamIds.some((teamId) => teamIds.has(teamId))
  ));
  return {
    ...actorRef(member, relationship),
    scope: sanitizeScopes(relationship?.scope ?? []),
    capabilities: member.capabilities,
    dispatchTargets: machines
      .map((machine) => machine.dispatchTarget)
      .filter((target): target is DispatchTargetRef => Boolean(target))
      .map(sanitizeDispatchTarget),
  };
}

function delegationFilterReason(
  data: OrgGraphData,
  member: MemberRecord,
  target: DelegationTarget,
  options: ResolveDelegationOptions,
): string | undefined {
  if (member.status !== "active") return `target status is ${member.status}`;
  if (options.capability) {
    if (!memberHasCapability(data, member, options.capability)) return `target lacks capability ${options.capability}`;
    const capability = findCapability(data, options.capability);
    const scopedCapabilityIds = target.scope.map((scope) => scope.capabilityId).filter((id): id is string => Boolean(id));
    if (capability && scopedCapabilityIds.length > 0 && !scopedCapabilityIds.includes(capability.id)) {
      return `delegation is not scoped to capability ${options.capability}`;
    }
  }
  const teamRef = options.team;
  if (teamRef && !member.teamIds.some((teamId) => matchesRecord(data.teams.find((team) => team.id === teamId), teamRef))) return `target is not in team ${teamRef}`;
  if (options.project) {
    const project = findProject(data, options.project);
    if (!project) return `project not found: ${options.project}`;
    const scopedProjectIds = target.scope.map((scope) => scope.projectId).filter((id): id is string => Boolean(id));
    const hasProjectScope = scopedProjectIds.length > 0 && scopedProjectIds.includes(project.id);
    const hasProject = hasProjectScope || project.ownerMemberIds.includes(member.id) || project.ownerTeamIds.some((teamId) => member.teamIds.includes(teamId));
    if (!hasProject) return `target is not related to project ${options.project}`;
  }
  if (options.machine) {
    const machine = findMachine(data, options.machine);
    if (!machine) return `machine not found: ${options.machine}`;
    const scopedMachineIds = target.scope.map((scope) => scope.machineId).filter((id): id is string => Boolean(id));
    const hasMachineScope = scopedMachineIds.length > 0 && scopedMachineIds.includes(machine.id);
    const hasMachine = hasMachineScope || machine.assignedMemberIds.includes(member.id) || machine.assignedTeamIds.some((teamId) => member.teamIds.includes(teamId));
    if (!hasMachine) return `target is not assigned to machine ${options.machine}`;
  }
  if (target.dispatchTargets.length > 0 && target.dispatchTargets.every((dispatch) => dispatch.state === "active" || dispatch.state === "stale" || dispatch.state === "unavailable")) {
    return "all known dispatch targets are active, stale, or unavailable";
  }
  return undefined;
}

function buildRelatedProjects(data: OrgGraphData, member: MemberRecord, roles: RoleRecord[]): SnapshotProjectRef[] {
  const teamIds = new Set(member.teamIds);
  const roleIds = new Set(roles.map((role) => role.id));
  const projects = data.projects.filter((project) => (
    project.ownerMemberIds.includes(member.id) ||
    project.ownerTeamIds.some((teamId) => teamIds.has(teamId)) ||
    project.stewardRoleIds.some((roleId) => roleIds.has(roleId))
  ));
  return projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    projectRef: publicExternalRef(project.projectRef),
    roles: [
      project.ownerMemberIds.includes(member.id) ? "owner" : "",
      project.ownerTeamIds.some((teamId) => teamIds.has(teamId)) ? "team-owner" : "",
      project.stewardRoleIds.some((roleId) => roleIds.has(roleId)) ? "steward" : "",
    ].filter(Boolean),
    capabilities: project.capabilityIds,
  }));
}

function buildMachineAssignments(
  data: OrgGraphData,
  member: MemberRecord,
  teams: TeamRecord[],
  projects: SnapshotProjectRef[],
): SnapshotMachineRef[] {
  const teamIds = new Set(teams.map((team) => team.id));
  const projectIds = new Set(projects.map((project) => project.projectId));
  return data.machines
    .filter((machine) => (
      machine.assignedMemberIds.includes(member.id) ||
      machine.assignedTeamIds.some((teamId) => teamIds.has(teamId)) ||
      machine.projectIds.some((projectId) => projectIds.has(projectId))
    ))
    .map((machine) => ({
      machineId: machine.id,
      name: machine.name,
      machineRef: publicExternalRef(machine.machineRef),
      dispatchTarget: machine.dispatchTarget ? sanitizeDispatchTarget(machine.dispatchTarget) : undefined,
      projects: machine.projectIds,
      capabilities: machine.capabilityIds,
    }));
}

function buildPolicyContext(data: OrgGraphData, member: MemberRecord, now: string): SnapshotPolicyRef[] {
  return data.relationships
    .filter((relationship) => (
      relationship.kind === "policy_context" &&
      relationship.source.kind === "member" &&
      relationship.source.id === member.id &&
      isRelationshipActive(relationship, now)
    ))
    .map((relationship) => ({
      relationshipId: relationship.id,
      target: publicNodeRef(relationship.target),
      authority: relationship.authority,
      scope: sanitizeScopes(relationship.scope),
    }));
}

function resolveMemberCapabilities(data: OrgGraphData, member: MemberRecord, roles: RoleRecord[]): CapabilityRecord[] {
  const refs = unique([...member.capabilities, ...roles.flatMap((role) => role.requiredCapabilities)]);
  return refs
    .map((ref) => findCapability(data, ref))
    .filter((capability): capability is CapabilityRecord => Boolean(capability));
}

function findCapability(data: OrgGraphData, ref: string): CapabilityRecord | undefined {
  return data.capabilities.find((capability) => (
    capability.id === ref ||
    capability.slug === ref ||
    capability.key === ref ||
    `${capability.namespace}:${capability.key}` === ref
  ));
}

function memberHasCapability(data: OrgGraphData, member: MemberRecord, ref: string): boolean {
  const roleCapabilities = member.roleIds
    .map((roleId) => data.roles.find((role) => role.id === roleId))
    .filter((role): role is RoleRecord => Boolean(role))
    .flatMap((role) => role.requiredCapabilities);
  const memberCapabilities = [...member.capabilities, ...roleCapabilities];
  if (memberCapabilities.includes(ref)) return true;
  const capability = findCapability(data, ref);
  if (!capability) return false;
  return memberCapabilities.includes(capability.id) || memberCapabilities.includes(`${capability.namespace}:${capability.key}`) || capability.ownerMemberIds.includes(member.id);
}

function findProject(data: OrgGraphData, ref: string): ProjectRecord | undefined {
  return data.projects.find((project) => project.id === ref || project.slug === ref || project.projectRef.id === ref);
}

function findMachine(data: OrgGraphData, ref: string): MachineRecord | undefined {
  return data.machines.find((machine) => machine.id === ref || machine.slug === ref || machine.machineRef.id === ref);
}

function actorRef(member: MemberRecord, relationship?: RelationshipRecord): SnapshotActorRef {
  return {
    memberId: member.id,
    displayName: member.displayName,
    kind: member.kind,
    identityRef: publicExternalRef(member.identityRef),
    authority: relationship?.authority,
    relationshipId: relationship?.id,
  };
}

function sanitizeScopes(scopes: RelationshipScope[]): RelationshipScope[] {
  return scopes.map((scope) => ({
    ...scope,
    external: scope.external ? publicExternalRef(scope.external) : undefined,
  }));
}

function sanitizeDispatchTarget(target: DispatchTargetRef): DispatchTargetRef {
  return {
    machine: target.machine,
    target: target.target,
    source: target.source,
    state: target.state,
    lastSeenAt: target.lastSeenAt,
  };
}

function collectSnapshotWarnings(
  member: MemberRecord,
  projects: SnapshotProjectRef[],
  machines: SnapshotMachineRef[],
  delegationTargets: DelegationTarget[],
): string[] {
  const warnings: string[] = [];
  if (member.identityRef.stale) warnings.push("identity reference is stale");
  for (const project of projects) {
    if (project.projectRef.stale) warnings.push(`project reference is stale: ${project.projectId}`);
  }
  for (const machine of machines) {
    if (machine.machineRef.stale) warnings.push(`machine reference is stale: ${machine.machineId}`);
    if (machine.dispatchTarget?.state === "stale" || machine.dispatchTarget?.state === "unavailable") {
      warnings.push(`machine dispatch target is ${machine.dispatchTarget.state}: ${machine.machineId}`);
    }
  }
  for (const target of delegationTargets) {
    if (target.dispatchTargets.length === 0) warnings.push(`delegation target has no dispatch evidence: ${target.memberId}`);
  }
  return unique(warnings);
}

function dedupeDelegationTargets(targets: DelegationTarget[]): DelegationTarget[] {
  const byId = new Map<string, DelegationTarget>();
  for (const target of targets) {
    const existing = byId.get(target.memberId);
    if (!existing) {
      byId.set(target.memberId, target);
      continue;
    }
    byId.set(target.memberId, {
      ...existing,
      scope: [...existing.scope, ...target.scope],
      capabilities: unique([...existing.capabilities, ...target.capabilities]),
      dispatchTargets: [...existing.dispatchTargets, ...target.dispatchTargets],
    });
  }
  return [...byId.values()];
}

function matchesRecord(record: GraphNode | undefined, target: string): boolean {
  return Boolean(record && (record.id === target || record.slug === target || record.slug === target.toLowerCase()));
}

function listLines(values: string[]): string[] {
  if (values.length === 0) return ["- None"];
  return values.map((value) => `- ${value}`);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
