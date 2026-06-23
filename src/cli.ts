#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JsonOrgStore,
  createAgentSnapshot,
  findNode,
  findRelationship,
  formatAgentSnapshotMarkdown,
  nodeRefFor,
  normalizeGraphData,
  resolveDelegationTargets,
  validateGraphData,
  type CreateMachineInput,
  type CreateRelationshipInput,
  type DispatchTargetState,
  type ExternalRef,
  type GraphCollectionName,
  type MemberKind,
  type MemberStatus,
  type OrgGraphData,
  type OrgNodeKind,
  type RelationshipAuthority,
  type RelationshipKind,
  type RelationshipScope,
} from "./index.js";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

interface CliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  throwOnError?: boolean;
}

const booleanFlags = new Set(["json", "j", "help", "h", "version", "dry-run"]);
const memberKinds = ["human", "agent", "service-account"] as const;
const memberStatuses = ["active", "inactive", "external", "archived"] as const;
const relationshipKinds = [
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
] as const;
const relationshipAuthorities = ["none", "recommend", "execute", "approve", "admin"] as const;
const dispatchTargetStates = ["idle", "active", "unknown", "stale", "unavailable"] as const;

const groupToCollection: Record<string, GraphCollectionName> = {
  orgs: "orgs",
  teams: "teams",
  functions: "functions",
  roles: "roles",
  members: "members",
  agents: "members",
  services: "members",
  projects: "projects",
  machines: "machines",
  capabilities: "capabilities",
  relationships: "relationships",
};

const helpText = `orgs

Usage:
  orgs [--json] [--store <path>] <command>

Commands:
  init
  status
  validate | doctor
  export [path]
  import <path> [--dry-run]
  orgs add --name <name> [--parent <org>] [--identity <system:kind:id>]
  orgs list | show <id|slug>
  teams add --org <org> --name <name> [--parent <team>]
  functions add --org <org> --name <name>
  roles add --org <org> --name <name> [--team <team>] [--function <function>] [--responsibility <text>] [--capability <namespace:key>]
  members add --org <org> --kind human|agent|service-account --name <name> --identity <kind:id>
  agents add --org <org> --name <name> --identity <agent:id>
  services add --org <org> --name <name> --identity <service:id>
  projects add --org <org> --name <name> --project-ref <system:kind:id>
  machines add --org <org> --name <name> --machine-ref <system:kind:id> [--dispatch-target <tmux-target>]
  capabilities add --org <org> --namespace <name> --key <key> [--owner-member <member>]
  relationships add --kind <kind> --from <kind:id|slug> --to <kind:id|slug> [--authority execute]
  relationships list | show <id|slug> | remove <id|slug>
  snapshot <member> [--format json|markdown] [--out <path>]
  snapshot export <member> [--format json|markdown] [--out <path>]
  resolve [--actor <member>] [--capability <namespace:key>] [--team <team>] [--project <project>] [--machine <machine>]

Data is stored in ~/.hasna/orgs/orgs.json by default.
Set OPEN_ORGS_STORE/OPEN_ORGS_AUDIT or pass --store for isolated local stores.`;

export async function runCli(argv = process.argv.slice(2), deps: CliDeps = {}): Promise<void> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const parsed = parseArgs(argv);
  const json = hasFlag(parsed, "json");
  const store = new JsonOrgStore({ filePath: flagValue(parsed, "store"), auditPath: flagValue(parsed, "audit") });

  try {
    await dispatch(parsed, store, json, out, deps.throwOnError !== true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (deps.throwOnError) throw error;
    if (json) out(JSON.stringify({ error: message }, null, 2));
    else err(message);
    process.exitCode = 1;
  }
}

async function dispatch(parsed: ParsedArgs, store: JsonOrgStore, json: boolean, out: (text: string) => void, mutateExitCode: boolean): Promise<void> {
  const [command, subcommand, ...rest] = parsed.positionals;
  if (!command || command === "help" || hasFlag(parsed, "help") || hasFlag(parsed, "h")) {
    out(helpText);
    return;
  }
  if (command === "version" || hasFlag(parsed, "version")) {
    output({ version: packageVersion() }, json, out, () => packageVersion());
    return;
  }
  if (command === "init") {
    await store.init();
    output(await store.status(), json, out, (status) => `initialized ${status.files.store.path}`);
    return;
  }
  if (command === "status") {
    output(await store.status(), json, out, (status) => `orgs store: ${status.files.store.path}\nrecords: ${Object.values(status.counts).reduce((sum, count) => sum + count, 0)}`);
    return;
  }
  if (command === "validate" || command === "doctor") {
    const result = await store.validate();
    output(result, json, out, (value) => {
      const lines = [`valid: ${value.valid}`, `issues: ${value.issues.length}`];
      for (const issue of value.issues) lines.push(`${issue.level}\t${issue.code}\t${issue.message}`);
      return lines.join("\n");
    });
    if (!result.valid && mutateExitCode) process.exitCode = 1;
    return;
  }
  if (command === "export") {
    const data = await store.exportData();
    const path = subcommand;
    if (path) {
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      output({ path, exported: countRecords(data) }, json, out, () => `exported ${countRecords(data)} record(s) to ${path}`);
    } else {
      output(data, true, out);
    }
    return;
  }
  if (command === "import") {
    const path = required(subcommand, "import requires a path");
    const data = normalizeGraphData(JSON.parse(await readFile(path, "utf8")) as Partial<OrgGraphData>);
    if (hasFlag(parsed, "dry-run")) {
      const result = validateGraphData(data);
      output({ dryRun: true, records: countRecords(data), valid: result.valid, issues: result.issues }, json, out, (value) => `dry run import: ${value.records} record(s), valid=${value.valid}`);
      return;
    }
    await store.replaceAll(data);
    output({ imported: countRecords(data), path }, json, out, () => `imported ${countRecords(data)} record(s) from ${path}`);
    return;
  }
  if (command === "snapshot") {
    const target = subcommand === "export" ? required(rest[0], "snapshot export requires a member") : required(subcommand, "snapshot requires a member");
    const data = await store.exportData();
    const snapshot = createAgentSnapshot(data, target);
    const format = flagValue(parsed, "format") ?? (json ? "json" : "markdown");
    const text = format === "markdown" ? formatAgentSnapshotMarkdown(snapshot) : `${JSON.stringify(snapshot, null, 2)}\n`;
    const outPath = flagValue(parsed, "out");
    if (outPath) {
      await writeFile(outPath, text, "utf8");
      output({ path: outPath, format, memberId: snapshot.identity.memberId }, json, out, () => `wrote ${format} snapshot to ${outPath}`);
    } else {
      out(text.trimEnd());
    }
    return;
  }
  if (command === "resolve") {
    const data = await store.exportData();
    const result = resolveDelegationTargets(data, {
      actor: flagValue(parsed, "actor"),
      capability: flagValue(parsed, "capability"),
      team: flagValue(parsed, "team"),
      project: flagValue(parsed, "project"),
      machine: flagValue(parsed, "machine"),
    });
    output(result, json, out, (value) => {
      if (value.targets.length === 0) return "no delegation targets";
      return value.targets.map((target) => `${target.memberId}\t${target.displayName}\t${target.authority ?? ""}`).join("\n");
    });
    return;
  }

  const collection = groupToCollection[command];
  if (!collection) throw new Error(`Unknown command: ${command}`);
  if (subcommand === "add") {
    const record = await addRecord(command, parsed, store);
    output(record, json, out, (value) => `${value.id}\t${value.slug}\t${recordDisplayName(value)}`);
    return;
  }
  if (subcommand === "list" || !subcommand) {
    const records = await store.list(collection);
    output(records, json, out, () => records.map((record) => `${record.id}\t${record.slug}\t${"name" in record ? record.name : record.kind}`).join("\n"));
    return;
  }
  if (subcommand === "show") {
    const target = required(rest[0], `${command} show requires a target`);
    if (collection === "relationships") {
      const relationship = findRelationship(await store.exportData(), target);
      if (!relationship) throw new Error(`Relationship not found: ${target}`);
      output(relationship, json, out);
      return;
    }
    const node = await store.getNode(target, [nodeKindForCollection(collection)]);
    if (!node) throw new Error(`Record not found: ${target}`);
    output(node, json, out);
    return;
  }
  if (command === "relationships" && subcommand === "remove") {
    const target = required(rest[0], "relationships remove requires a target");
    output({ deleted: await store.removeRelationship(target) }, json, out, (value) => `deleted: ${value.deleted}`);
    return;
  }
  throw new Error(`Unknown ${command} command: ${subcommand}`);
}

async function addRecord(group: string, parsed: ParsedArgs, store: JsonOrgStore) {
  const data = await store.exportData();
  if (group === "orgs") {
    return store.createOrg({
      name: required(flagValue(parsed, "name"), "orgs add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      parentOrgId: resolveOptionalId(data, flagValue(parsed, "parent"), ["org"]),
      identityRef: parseExternalFlag(parsed, "identity", "open-identities", "organization"),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "teams") {
    return store.createTeam({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "teams add requires --org", ["org"]),
      name: required(flagValue(parsed, "name"), "teams add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      parentTeamId: resolveOptionalId(data, flagValue(parsed, "parent"), ["team"]),
      functionIds: resolveManyIds(data, flagValues(parsed, "function"), ["function"]),
      identityRef: parseExternalFlag(parsed, "identity", "open-identities", "organization"),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "functions") {
    return store.createFunction({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "functions add requires --org", ["org"]),
      name: required(flagValue(parsed, "name"), "functions add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      parentFunctionId: resolveOptionalId(data, flagValue(parsed, "parent"), ["function"]),
      capabilityIds: resolveManyIds(data, flagValues(parsed, "capability"), ["capability"]),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "roles") {
    return store.createRole({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "roles add requires --org", ["org"]),
      name: required(flagValue(parsed, "name"), "roles add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      teamId: resolveOptionalId(data, flagValue(parsed, "team"), ["team"]),
      functionId: resolveOptionalId(data, flagValue(parsed, "function"), ["function"]),
      responsibilities: flagValues(parsed, "responsibility"),
      requiredCapabilities: flagValues(parsed, "capability"),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "members" || group === "agents" || group === "services") {
    const defaultKind = group === "agents" ? "agent" : group === "services" ? "service-account" : undefined;
    const kind = defaultKind ?? parseMemberKind(required(flagValue(parsed, "kind"), "members add requires --kind"));
    return store.createMember({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), `${group} add requires --org`, ["org"]),
      kind,
      name: required(flagValue(parsed, "name"), `${group} add requires --name`),
      slug: flagValue(parsed, "slug"),
      displayName: flagValue(parsed, "display-name"),
      description: flagValue(parsed, "description"),
      identityRef: requiredExternalFlag(parsed, "identity", "open-identities", kind === "service-account" ? "service" : kind),
      roleIds: resolveManyIds(data, flagValues(parsed, "role"), ["role"]),
      teamIds: resolveManyIds(data, flagValues(parsed, "team"), ["team"]),
      functionIds: resolveManyIds(data, flagValues(parsed, "function"), ["function"]),
      capabilities: flagValues(parsed, "capability"),
      responsibilities: flagValues(parsed, "responsibility"),
      status: flagValue(parsed, "status") ? parseMemberStatus(flagValue(parsed, "status")!) : "active",
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "projects") {
    return store.createProject({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "projects add requires --org", ["org"]),
      name: required(flagValue(parsed, "name"), "projects add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      projectRef: requiredExternalFlag(parsed, "project-ref", "open-projects", "workspace"),
      ownerMemberIds: resolveManyIds(data, flagValues(parsed, "owner-member"), ["member"]),
      ownerTeamIds: resolveManyIds(data, flagValues(parsed, "owner-team"), ["team"]),
      stewardRoleIds: resolveManyIds(data, flagValues(parsed, "steward-role"), ["role"]),
      capabilityIds: resolveManyIds(data, flagValues(parsed, "capability"), ["capability"]),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "machines") {
    const dispatchTarget = flagValue(parsed, "dispatch-target");
    const input: CreateMachineInput = {
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "machines add requires --org", ["org"]),
      name: required(flagValue(parsed, "name"), "machines add requires --name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      machineRef: requiredExternalFlag(parsed, "machine-ref", "open-machines", "machine"),
      assignedMemberIds: resolveManyIds(data, flagValues(parsed, "assigned-member"), ["member"]),
      assignedTeamIds: resolveManyIds(data, flagValues(parsed, "assigned-team"), ["team"]),
      projectIds: resolveManyIds(data, flagValues(parsed, "project"), ["project"]),
      capabilityIds: resolveManyIds(data, flagValues(parsed, "capability"), ["capability"]),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    };
    if (dispatchTarget) {
      input.dispatchTarget = {
        target: dispatchTarget,
        machine: flagValue(parsed, "dispatch-machine"),
        source: "manual",
        state: flagValue(parsed, "dispatch-state") ? parseDispatchTargetState(flagValue(parsed, "dispatch-state")!) : "unknown",
        lastSeenAt: flagValue(parsed, "dispatch-last-seen"),
      };
    }
    return store.createMachine(input);
  }
  if (group === "capabilities") {
    return store.createCapability({
      orgId: resolveRequiredId(data, flagValue(parsed, "org"), "capabilities add requires --org", ["org"]),
      namespace: required(flagValue(parsed, "namespace"), "capabilities add requires --namespace"),
      key: required(flagValue(parsed, "key"), "capabilities add requires --key"),
      name: flagValue(parsed, "name"),
      slug: flagValue(parsed, "slug"),
      description: flagValue(parsed, "description"),
      ownerMemberIds: resolveManyIds(data, flagValues(parsed, "owner-member"), ["member"]),
      ownerTeamIds: resolveManyIds(data, flagValues(parsed, "owner-team"), ["team"]),
      ownerRoleIds: resolveManyIds(data, flagValues(parsed, "owner-role"), ["role"]),
      ownerFunctionIds: resolveManyIds(data, flagValues(parsed, "owner-function"), ["function"]),
      ownerProjectIds: resolveManyIds(data, flagValues(parsed, "owner-project"), ["project"]),
      metadata: parseJsonFlag(parsed, "metadata-json"),
    });
  }
  if (group === "relationships") {
    const input: CreateRelationshipInput = {
      kind: parseRelationshipKind(required(flagValue(parsed, "kind"), "relationships add requires --kind")),
      slug: flagValue(parsed, "slug"),
      source: parseNodeRef(data, required(flagValue(parsed, "from"), "relationships add requires --from")),
      target: parseNodeRef(data, required(flagValue(parsed, "to"), "relationships add requires --to")),
      authority: flagValue(parsed, "authority") ? parseRelationshipAuthority(flagValue(parsed, "authority")!) : "none",
      scope: parseScopes(data, parsed),
      allowedActions: flagValues(parsed, "allow"),
      deniedActions: flagValues(parsed, "deny"),
      validFrom: flagValue(parsed, "valid-from"),
      expiresAt: flagValue(parsed, "expires-at"),
      revokedAt: flagValue(parsed, "revoked-at"),
      confidence: flagValue(parsed, "confidence") ? parseConfidence(flagValue(parsed, "confidence")!) : undefined,
      metadata: parseJsonFlag(parsed, "metadata-json"),
    };
    return store.createRelationship(input);
  }
  throw new Error(`Unsupported add group: ${group}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const normalized = arg.replace(/^-+/, "");
    const equalsIndex = normalized.indexOf("=");
    const key = equalsIndex === -1 ? normalized : normalized.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : normalized.slice(equalsIndex + 1);
    if (booleanFlags.has(key)) {
      addFlag(flags, key, "true");
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`--${key} requires a value`);
    addFlag(flags, key, value);
  }
  return { positionals, flags };
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name) || (name === "json" && parsed.flags.has("j"));
}

function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

function flagValues(parsed: ParsedArgs, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

function addFlag(flags: Map<string, string[]>, key: string, value: string): void {
  const values = flags.get(key) ?? [];
  values.push(value);
  flags.set(key, values);
}

function output<T>(value: T, json: boolean, out: (text: string) => void, human?: (value: T) => string): void {
  if (json) out(JSON.stringify(value, null, 2));
  else out(human ? human(value) : JSON.stringify(value, null, 2));
}

function parseExternalFlag(parsed: ParsedArgs, name: string, defaultSystem: string, defaultKind: string): ExternalRef | undefined {
  const value = flagValue(parsed, name);
  return value ? parseExternalRef(value, defaultSystem, defaultKind) : undefined;
}

function requiredExternalFlag(parsed: ParsedArgs, name: string, defaultSystem: string, defaultKind: string): ExternalRef {
  return parseExternalRef(required(flagValue(parsed, name), `--${name} is required`), defaultSystem, defaultKind);
}

function parseExternalRef(value: string, defaultSystem: string, defaultKind: string): ExternalRef {
  const parts = value.split(":");
  if (parts.length >= 3) {
    const [system, kind, ...idParts] = parts;
    return { system, kind, id: idParts.join(":") };
  }
  if (parts.length === 2) {
    const [kind, id] = parts;
    return { system: defaultSystem, kind, id };
  }
  return { system: defaultSystem, kind: defaultKind, id: value };
}

function parseJsonFlag(parsed: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const value = flagValue(parsed, name);
  if (!value) return undefined;
  const parsedValue = JSON.parse(value);
  if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) throw new Error(`--${name} must be a JSON object`);
  return parsedValue as Record<string, unknown>;
}

function parseNodeRef(data: OrgGraphData, value: string) {
  if (value.startsWith("external:")) {
    const ref = parseExternalRef(value.slice("external:".length), "external", "record");
    return { kind: "external" as const, id: ref.id, external: ref };
  }
  const separator = value.indexOf(":");
  if (separator > 0) {
    const kind = value.slice(0, separator) as OrgNodeKind;
    const target = value.slice(separator + 1);
    if (kind === "external") throw new Error("external refs must use external:<system:kind:id>");
    const node = findNode(data, target, [kind]);
    if (!node) throw new Error(`Node not found: ${value}`);
    return nodeRefFor(node);
  }
  const node = findNode(data, value);
  if (!node) throw new Error(`Node not found: ${value}`);
  return nodeRefFor(node);
}

function parseScopes(data: OrgGraphData, parsed: ParsedArgs): RelationshipScope[] {
  const scopes: RelationshipScope[] = [];
  for (const orgId of resolveManyIds(data, flagValues(parsed, "scope-org"), ["org"])) scopes.push({ orgId });
  for (const teamId of resolveManyIds(data, flagValues(parsed, "scope-team"), ["team"])) scopes.push({ teamId });
  for (const functionId of resolveManyIds(data, flagValues(parsed, "scope-function"), ["function"])) scopes.push({ functionId });
  for (const projectId of resolveManyIds(data, flagValues(parsed, "scope-project"), ["project"])) scopes.push({ projectId });
  for (const machineId of resolveManyIds(data, flagValues(parsed, "scope-machine"), ["machine"])) scopes.push({ machineId });
  for (const capabilityId of resolveManyIds(data, flagValues(parsed, "scope-capability"), ["capability"])) scopes.push({ capabilityId });
  for (const value of flagValues(parsed, "scope-external")) scopes.push({ external: parseExternalRef(value, "external", "record") });
  return scopes;
}

function resolveRequiredId(data: OrgGraphData, value: string | undefined, message: string, kinds: OrgNodeKind[]): string {
  return resolveId(data, required(value, message), kinds);
}

function resolveOptionalId(data: OrgGraphData, value: string | undefined, kinds: OrgNodeKind[]): string | undefined {
  return value ? resolveId(data, value, kinds) : undefined;
}

function resolveManyIds(data: OrgGraphData, values: string[], kinds: OrgNodeKind[]): string[] {
  return values.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).map((value) => resolveId(data, value, kinds));
}

function resolveId(data: OrgGraphData, value: string, kinds: OrgNodeKind[]): string {
  const node = findNode(data, value, kinds);
  if (!node) throw new Error(`Record not found: ${value}`);
  return node.id;
}

function nodeKindForCollection(collection: GraphCollectionName): OrgNodeKind {
  if (collection === "relationships") throw new Error("relationships are not nodes");
  return collectionForKindReverse(collection);
}

function collectionForKindReverse(collection: Exclude<GraphCollectionName, "relationships">): OrgNodeKind {
  const kind = Object.entries({
    org: "orgs",
    team: "teams",
    function: "functions",
    role: "roles",
    member: "members",
    project: "projects",
    machine: "machines",
    capability: "capabilities",
  }).find(([, value]) => value === collection)?.[0] as OrgNodeKind | undefined;
  if (!kind) throw new Error(`Unsupported collection: ${collection}`);
  return kind;
}

function countRecords(data: OrgGraphData): number {
  return data.orgs.length + data.teams.length + data.functions.length + data.roles.length + data.members.length + data.projects.length + data.machines.length + data.capabilities.length + data.relationships.length;
}

function recordDisplayName(record: { kind?: string; name?: string }): string {
  return record.name ?? record.kind ?? "";
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function parseMemberKind(value: string): MemberKind {
  return parseEnum(value, memberKinds, "member kind");
}

function parseMemberStatus(value: string): MemberStatus {
  return parseEnum(value, memberStatuses, "member status");
}

function parseRelationshipKind(value: string): RelationshipKind {
  return parseEnum(value, relationshipKinds, "relationship kind");
}

function parseRelationshipAuthority(value: string): RelationshipAuthority {
  return parseEnum(value, relationshipAuthorities, "relationship authority");
}

function parseDispatchTargetState(value: string): DispatchTargetState {
  return parseEnum(value, dispatchTargetStates, "dispatch target state");
}

function parseConfidence(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("confidence must be a number between 0 and 1");
  return parsed;
}

function parseEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${label}: ${value}; expected one of ${allowed.join(", ")}`);
}

function packageVersion(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(packagePath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (import.meta.main) {
  await runCli();
}
