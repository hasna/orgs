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
  type GraphNode,
  type GraphRecord,
  type MemberKind,
  type MemberStatus,
  type OrgStoreStatus,
  type OrgGraphData,
  type OrgNodeKind,
  type RelationshipRecord,
  type RelationshipAuthority,
  type RelationshipKind,
  type RelationshipScope,
  type ValidationResult,
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

const booleanFlags = new Set(["json", "j", "help", "h", "version", "dry-run", "verbose", "v"]);
const defaultHumanLimit = 20;
const defaultTextLimit = 96;
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
  orgs [--json] [--verbose] [--limit <n>] [--cursor <offset>] [--store <path>] <command>

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

Human output is compact by default. Use --verbose for extra fields, --json for
stable full records, --limit/--cursor for pagination, and --filter <text> to
filter list output.

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
    output(await store.status(), json, out, (status) => formatStatus(status, parsed));
    return;
  }
  if (command === "validate" || command === "doctor") {
    const result = await store.validate();
    output(result, json, out, (value) => formatValidation(value, parsed));
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
    output(result, json, out, (value) => formatResolution(value, parsed));
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
    const allRecords = await store.list(collection);
    const filtered = filterRecords(allRecords, parsed);
    if (json && hasPagingFlags(parsed)) {
      output(pagedJson(filtered.records, parsed), true, out);
    } else {
      output(filtered.records, json, out, () => formatRecordList(command, filtered.records, allRecords.length, parsed));
    }
    return;
  }
  if (subcommand === "show") {
    const target = required(rest[0], `${command} show requires a target`);
    if (collection === "relationships") {
      const relationship = findRelationship(await store.exportData(), target);
      if (!relationship) throw new Error(`Relationship not found: ${target}`);
      output(relationship, json, out, (value) => formatRecordDetails(value, parsed));
      return;
    }
    const node = await store.getNode(target, [nodeKindForCollection(collection)]);
    if (!node) throw new Error(`Record not found: ${target}`);
    output(node, json, out, (value) => formatRecordDetails(value, parsed));
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

interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextCursor?: string;
}

function formatStatus(status: OrgStoreStatus, parsed: ParsedArgs): string {
  const verbose = isVerbose(parsed);
  const total = Object.values(status.counts).reduce((sum, count) => sum + count, 0);
  const nonZeroCounts = Object.entries(status.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  const lines = [
    `orgs store: ${status.files.store.path}`,
    `records: ${total}${nonZeroCounts ? ` (${nonZeroCounts})` : ""}`,
  ];
  for (const warning of status.warnings) {
    lines.push(`warning: ${warning.message}`);
  }
  if (verbose) {
    lines.push(`audit: ${status.files.audit.path} (${status.files.audit.exists ? "exists" : "missing"})`);
    lines.push(`data dir: ${status.dataDir}`);
    for (const alternate of status.files.alternateStores) {
      const size = alternate.sizeBytes === undefined ? "unknown size" : `${alternate.sizeBytes} bytes`;
      lines.push(`alternate store: ${alternate.kind} ${alternate.path} (${alternate.reason}, ${size}${alternate.modifiedAt ? `, modified ${alternate.modifiedAt}` : ""})`);
    }
    lines.push(formatTable(
      ["collection", "count"],
      Object.entries(status.counts).map(([name, count]) => [name, String(count)]),
    ));
    lines.push(`safety: metadata-only status=${status.safety.statusOutputIsMetadataOnly}, snapshots-strip-private-metadata=${status.safety.snapshotsStripPrivateMetadata}`);
  } else {
    lines.push("hint: use --verbose for file/audit details or --json for machine-readable status.");
  }
  return lines.join("\n");
}

function formatValidation(result: ValidationResult, parsed: ParsedArgs): string {
  const verbose = isVerbose(parsed);
  const page = pageItems(result.issues, parsed);
  const lines = [`valid: ${result.valid}`, `issues: ${result.issues.length}`];
  if (page.items.length > 0) {
    const headers = verbose ? ["level", "code", "id", "message"] : ["level", "code", "message"];
    const rows = page.items.map((issue) => (
      verbose
        ? [issue.level, issue.code, issue.id ?? "", clip(issue.message, 160)]
        : [issue.level, issue.code, clip(issue.message)]
    ));
    lines.push(formatTable(headers, rows));
  }
  lines.push(pageHint(page, "validation issues", "--verbose for ids, --limit/--cursor for more, or --json for full validation data"));
  return lines.join("\n");
}

function formatResolution(
  result: { targets: Array<{ memberId: string; displayName: string; authority?: string; capabilities?: string[]; dispatchTargets?: unknown[]; scope?: RelationshipScope[]; relationshipId?: string }>; refused: unknown[]; warnings: string[] },
  parsed: ParsedArgs,
): string {
  const verbose = isVerbose(parsed);
  const page = pageItems(result.targets, parsed);
  const lines = [`delegation targets: ${result.targets.length}`, `refused: ${result.refused.length}`, `warnings: ${result.warnings.length}`];
  if (page.items.length === 0) {
    lines.push("no delegation targets");
  } else {
    const headers = verbose ? ["member", "name", "authority", "capabilities", "dispatch", "scope"] : ["member", "name", "authority"];
    const rows = page.items.map((target) => (
      verbose
        ? [
          target.memberId,
          target.displayName,
          target.authority ?? "",
          joinLimited(target.capabilities ?? [], 4),
          joinLimited((target.dispatchTargets ?? []).map(formatDispatchTarget), 2),
          formatScopes(target.scope ?? []),
        ]
        : [target.memberId, target.displayName, target.authority ?? ""]
    ));
    lines.push(formatTable(headers, rows));
  }
  if (result.warnings.length > 0) {
    lines.push(`warning sample: ${joinLimited(result.warnings, verbose ? 5 : 2)}`);
  }
  lines.push(pageHint(page, "delegation targets", "--verbose for capabilities/dispatch/scope, --limit/--cursor for more, or --json for full resolution data"));
  return lines.join("\n");
}

function filterRecords(records: GraphRecord[], parsed: ParsedArgs): { records: GraphRecord[]; filter?: string } {
  const filter = listFilter(parsed);
  if (!filter) return { records };
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    filter,
    records: records.filter((record) => {
      const searchable = [
        record.id,
        record.slug,
        recordKind(record),
        "name" in record ? record.name : "",
        recordSummary(record, true),
        JSON.stringify(record),
      ].join(" ").toLowerCase();
      return terms.every((term) => searchable.includes(term));
    }),
  };
}

function formatRecordList(command: string, records: GraphRecord[], totalBeforeFilter: number, parsed: ParsedArgs): string {
  const verbose = isVerbose(parsed);
  const page = pageItems(records, parsed);
  const filter = listFilter(parsed);
  const totalText = filter ? `${records.length} matching of ${totalBeforeFilter}` : `${records.length} total`;
  const lines = [`${command}: ${pageRange(page)} (${totalText})`];
  if (page.items.length > 0) {
    const headers = verbose ? ["id", "slug", "kind", "summary", "links"] : ["id", "slug", "summary"];
    const rows = page.items.map((record) => (
      verbose
        ? [record.id, record.slug, recordKind(record), recordSummary(record, true), recordLinks(record)]
        : [record.id, record.slug, recordSummary(record, false)]
    ));
    lines.push(formatTable(headers, rows));
  }
  lines.push(pageHint(page, "records", `use ${command} show <id> for details, --verbose for more columns, --filter <text> to narrow, or --json for full records`));
  return lines.join("\n");
}

function formatRecordDetails(record: GraphRecord, parsed: ParsedArgs): string {
  const verbose = isVerbose(parsed);
  const lines = [`${recordKind(record)}: ${recordTitle(record)}`, `id: ${record.id}`, `slug: ${record.slug}`];
  if (isRelationshipRecord(record)) {
    lines.push(`kind: ${record.kind}`);
    lines.push(`source: ${formatNodeRef(record.source)}`);
    lines.push(`target: ${formatNodeRef(record.target)}`);
    lines.push(`authority: ${record.authority}`);
    lines.push(`scope: ${formatScopes(record.scope)}`);
    lines.push(`allowed actions: ${joinLimited(record.allowedActions, verbose ? 10 : 4)}`);
    if (record.deniedActions.length > 0 || verbose) lines.push(`denied actions: ${joinLimited(record.deniedActions, verbose ? 10 : 4)}`);
    lines.push(`confidence: ${record.confidence}`);
    if (record.validFrom || record.expiresAt || record.revokedAt || verbose) {
      lines.push(`window: ${record.validFrom ?? "unbounded"} to ${record.expiresAt ?? "unbounded"}${record.revokedAt ? `, revoked ${record.revokedAt}` : ""}`);
    }
    if (verbose) {
      lines.push(`provenance: ${record.provenance.source}${record.provenance.ref ? ` (${record.provenance.ref})` : ""}`);
      lines.push(`metadata keys: ${metadataKeys(record.metadata)}`);
      lines.push(`created: ${record.createdAt}`);
      lines.push(`updated: ${record.updatedAt}`);
    }
  } else {
    appendNodeDetails(lines, record, verbose);
  }
  lines.push(`hint: use --json for the full record${verbose ? "" : " or --verbose for extra fields"}.`);
  return lines.join("\n");
}

function appendNodeDetails(lines: string[], record: GraphNode, verbose: boolean): void {
  pushIf(lines, "name", "name" in record ? record.name : undefined);
  pushIf(lines, "description", record.description ? clip(record.description, verbose ? 220 : defaultTextLimit) : undefined);
  if ("orgId" in record) pushIf(lines, "org", record.orgId);
  if ("parentOrgId" in record) pushIf(lines, "parent org", record.parentOrgId);
  if ("parentTeamId" in record) pushIf(lines, "parent team", record.parentTeamId);
  if ("parentFunctionId" in record) pushIf(lines, "parent function", record.parentFunctionId);
  if ("displayName" in record) {
    lines.push(`kind: ${record.kind}`);
    lines.push(`display: ${record.displayName}`);
    lines.push(`status: ${record.status}`);
    lines.push(`identity: ${formatExternalRef(record.identityRef)}`);
    lines.push(`roles: ${joinLimited(record.roleIds, verbose ? 10 : 4)}`);
    lines.push(`teams: ${joinLimited(record.teamIds, verbose ? 10 : 4)}`);
    lines.push(`functions: ${joinLimited(record.functionIds, verbose ? 10 : 4)}`);
    lines.push(`capabilities: ${joinLimited(record.capabilities, verbose ? 10 : 4)}`);
    lines.push(`responsibilities: ${joinLimited(record.responsibilities.map((item) => clip(item)), verbose ? 10 : 3)}`);
  } else if ("projectRef" in record) {
    lines.push(`project ref: ${formatExternalRef(record.projectRef)}`);
    lines.push(`owner members: ${joinLimited(record.ownerMemberIds, verbose ? 10 : 4)}`);
    lines.push(`owner teams: ${joinLimited(record.ownerTeamIds, verbose ? 10 : 4)}`);
    lines.push(`steward roles: ${joinLimited(record.stewardRoleIds, verbose ? 10 : 4)}`);
    lines.push(`capabilities: ${joinLimited(record.capabilityIds, verbose ? 10 : 4)}`);
  } else if ("machineRef" in record) {
    lines.push(`machine ref: ${formatExternalRef(record.machineRef)}`);
    lines.push(`assigned members: ${joinLimited(record.assignedMemberIds, verbose ? 10 : 4)}`);
    lines.push(`assigned teams: ${joinLimited(record.assignedTeamIds, verbose ? 10 : 4)}`);
    lines.push(`projects: ${joinLimited(record.projectIds, verbose ? 10 : 4)}`);
    lines.push(`capabilities: ${joinLimited(record.capabilityIds, verbose ? 10 : 4)}`);
    lines.push(`dispatch: ${formatDispatchTarget(record.dispatchTarget)}`);
  } else if ("namespace" in record && "key" in record) {
    lines.push(`capability: ${record.namespace}:${record.key}`);
    lines.push(`owner members: ${joinLimited(record.ownerMemberIds, verbose ? 10 : 4)}`);
    lines.push(`owner teams: ${joinLimited(record.ownerTeamIds, verbose ? 10 : 4)}`);
    lines.push(`owner roles: ${joinLimited(record.ownerRoleIds, verbose ? 10 : 4)}`);
    lines.push(`owner functions: ${joinLimited(record.ownerFunctionIds, verbose ? 10 : 4)}`);
    lines.push(`owner projects: ${joinLimited(record.ownerProjectIds, verbose ? 10 : 4)}`);
  } else if ("responsibilities" in record && "requiredCapabilities" in record) {
    pushIf(lines, "team", record.teamId);
    pushIf(lines, "function", record.functionId);
    lines.push(`responsibilities: ${joinLimited(record.responsibilities.map((item) => clip(item)), verbose ? 10 : 3)}`);
    lines.push(`required capabilities: ${joinLimited(record.requiredCapabilities, verbose ? 10 : 4)}`);
  } else if ("functionIds" in record) {
    lines.push(`functions: ${joinLimited(record.functionIds, verbose ? 10 : 4)}`);
    if (record.identityRef) lines.push(`identity: ${formatExternalRef(record.identityRef)}`);
  } else if ("capabilityIds" in record) {
    lines.push(`capabilities: ${joinLimited(record.capabilityIds, verbose ? 10 : 4)}`);
  } else if ("identityRef" in record && record.identityRef) {
    lines.push(`identity: ${formatExternalRef(record.identityRef)}`);
  }
  if (verbose) {
    lines.push(`metadata keys: ${metadataKeys(record.metadata)}`);
    lines.push(`created: ${record.createdAt}`);
    lines.push(`updated: ${record.updatedAt}`);
    pushIf(lines, "archived", record.archivedAt);
  }
}

function recordSummary(record: GraphRecord, verbose: boolean): string {
  if (isRelationshipRecord(record)) {
    const actionSummary = record.allowedActions.length > 0 ? ` actions=${joinLimited(record.allowedActions, 2)}` : "";
    return `${record.kind} ${formatNodeRef(record.source)} -> ${formatNodeRef(record.target)} authority=${record.authority}${verbose ? ` scope=${formatScopes(record.scope)}${actionSummary}` : ""}`;
  }
  if ("displayName" in record) return `${record.kind} ${record.status} ${record.displayName}`;
  if ("namespace" in record && "key" in record) return `${record.namespace}:${record.key} owners=${ownerCount(record)}`;
  if ("machineRef" in record) return `${record.name} dispatch=${formatDispatchTarget(record.dispatchTarget)}`;
  if ("projectRef" in record) return `${record.name} owners=${record.ownerMemberIds.length + record.ownerTeamIds.length}`;
  if ("responsibilities" in record && "requiredCapabilities" in record) return `${record.name} responsibilities=${record.responsibilities.length} required=${record.requiredCapabilities.length}`;
  if ("functionIds" in record) return `${record.name} functions=${record.functionIds.length}`;
  if ("capabilityIds" in record) return `${record.name} capabilities=${record.capabilityIds.length}`;
  return (record as GraphNode).name;
}

function recordLinks(record: GraphRecord): string {
  if (isRelationshipRecord(record)) return `source=${formatNodeRef(record.source)} target=${formatNodeRef(record.target)} scope=${formatScopes(record.scope)}`;
  if ("displayName" in record) return `org=${record.orgId} teams=${record.teamIds.length} roles=${record.roleIds.length} caps=${record.capabilities.length}`;
  if ("projectRef" in record) return `org=${record.orgId} owners=${record.ownerMemberIds.length + record.ownerTeamIds.length} caps=${record.capabilityIds.length}`;
  if ("machineRef" in record) return `org=${record.orgId} assigned=${record.assignedMemberIds.length + record.assignedTeamIds.length} projects=${record.projectIds.length}`;
  if ("namespace" in record && "key" in record) return `org=${record.orgId} owners=${ownerCount(record)}`;
  if ("responsibilities" in record && "requiredCapabilities" in record) return `org=${record.orgId} team=${record.teamId ?? ""} function=${record.functionId ?? ""}`;
  if ("functionIds" in record) return `org=${record.orgId} functions=${record.functionIds.length}`;
  if ("capabilityIds" in record) return `org=${record.orgId} capabilities=${record.capabilityIds.length}`;
  if ("parentOrgId" in record) return `parent=${record.parentOrgId ?? ""}`;
  return "";
}

function recordKind(record: GraphRecord): string {
  if (isRelationshipRecord(record)) return "relationship";
  if ("displayName" in record) return "member";
  if ("namespace" in record && "key" in record) return "capability";
  if ("machineRef" in record) return "machine";
  if ("projectRef" in record) return "project";
  if ("responsibilities" in record && "requiredCapabilities" in record) return "role";
  if ("functionIds" in record) return "team";
  if ("capabilityIds" in record && "orgId" in record) return "function";
  return "org";
}

function recordTitle(record: GraphRecord): string {
  if (isRelationshipRecord(record)) return `${record.kind} ${formatNodeRef(record.source)} -> ${formatNodeRef(record.target)}`;
  return (record as GraphNode).name;
}

function isRelationshipRecord(record: GraphRecord): record is RelationshipRecord {
  return "source" in record && "target" in record && "authority" in record;
}

function pageItems<T>(items: T[], parsed: ParsedArgs, fallbackLimit = defaultHumanLimit): Page<T> {
  const offset = parseCursor(parsed);
  const limit = parseLimit(parsed) ?? fallbackLimit;
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    total: items.length,
    offset,
    limit,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function pagedJson<T>(items: T[], parsed: ParsedArgs): { records: T[]; page: { total: number; limit: number; cursor: string; nextCursor?: string } } {
  const page = pageItems(items, parsed);
  return {
    records: page.items,
    page: {
      total: page.total,
      limit: page.limit,
      cursor: String(page.offset),
      nextCursor: page.nextCursor,
    },
  };
}

function pageRange(page: Page<unknown>): string {
  if (page.total === 0 || page.items.length === 0) return `showing 0 of ${page.total}`;
  return `showing ${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`;
}

function pageHint(page: Page<unknown>, label: string, detailHint: string): string {
  const parts = [];
  if (page.nextCursor) parts.push(`next cursor: ${page.nextCursor}; use --cursor ${page.nextCursor} --limit ${page.limit} for more ${label}`);
  parts.push(`hint: ${detailHint}.`);
  return parts.join("\n");
}

function parseLimit(parsed: ParsedArgs): number | undefined {
  const value = flagValue(parsed, "limit");
  return value === undefined ? undefined : parsePositiveInteger(value, "--limit");
}

function parseCursor(parsed: ParsedArgs): number {
  const value = flagValue(parsed, "cursor");
  if (value === undefined) return 0;
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) throw new Error("--cursor must be a non-negative integer offset");
  return parsedValue;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) throw new Error(`${label} must be a positive integer`);
  return parsedValue;
}

function hasPagingFlags(parsed: ParsedArgs): boolean {
  return flagValue(parsed, "limit") !== undefined || flagValue(parsed, "cursor") !== undefined;
}

function listFilter(parsed: ParsedArgs): string | undefined {
  return flagValue(parsed, "filter") ?? flagValue(parsed, "query") ?? flagValue(parsed, "q");
}

function isVerbose(parsed: ParsedArgs): boolean {
  return hasFlag(parsed, "verbose") || hasFlag(parsed, "v");
}

function formatTable(headers: string[], rows: string[][]): string {
  const clippedRows = rows.map((row) => row.map((cell) => clip(String(cell))));
  const widths = headers.map((header, index) => {
    const maxCell = Math.max(header.length, ...clippedRows.map((row) => row[index]?.length ?? 0));
    return Math.min(Math.max(maxCell, header.length), index <= 1 ? 32 : 48);
  });
  const formatRow = (row: string[]) => row
    .map((cell, index) => clip(cell ?? "", widths[index]).padEnd(widths[index]))
    .join("  ")
    .trimEnd();
  return [formatRow(headers), formatRow(widths.map((width) => "-".repeat(width))), ...clippedRows.map(formatRow)].join("\n");
}

function clip(value: string, limit = defaultTextLimit): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function joinLimited(values: string[], limit = 4): string {
  if (values.length === 0) return "none";
  const shown = values.slice(0, limit).map((value) => clip(value, 48));
  return `${shown.join(", ")}${values.length > limit ? `, +${values.length - limit} more` : ""}`;
}

function formatScopes(scopes: RelationshipScope[]): string {
  if (scopes.length === 0) return "none";
  return joinLimited(scopes.map((scope) => Object.entries(scope)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => key === "external" ? `external=${formatExternalRef(value as ExternalRef)}` : `${key}=${String(value)}`)
    .join(",")), 4);
}

function formatNodeRef(ref: { kind: string; id: string; external?: ExternalRef }): string {
  return ref.kind === "external" && ref.external ? `external:${formatExternalRef(ref.external)}` : `${ref.kind}:${ref.id}`;
}

function formatExternalRef(ref: ExternalRef): string {
  return `${ref.system}:${ref.kind}:${ref.id}${ref.stale ? " (stale)" : ""}`;
}

function formatDispatchTarget(target: unknown): string {
  if (!target || typeof target !== "object") return "none";
  const dispatch = target as { target?: string; machine?: string; state?: string; source?: string };
  const location = dispatch.target ?? dispatch.machine ?? "unknown";
  return `${location}${dispatch.state ? ` ${dispatch.state}` : ""}${dispatch.source ? ` via ${dispatch.source}` : ""}`;
}

function metadataKeys(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata);
  return keys.length === 0 ? "none" : joinLimited(keys, 8);
}

function ownerCount(record: { ownerMemberIds?: string[]; ownerTeamIds?: string[]; ownerRoleIds?: string[]; ownerFunctionIds?: string[]; ownerProjectIds?: string[] }): number {
  return (record.ownerMemberIds?.length ?? 0) +
    (record.ownerTeamIds?.length ?? 0) +
    (record.ownerRoleIds?.length ?? 0) +
    (record.ownerFunctionIds?.length ?? 0) +
    (record.ownerProjectIds?.length ?? 0);
}

function pushIf(lines: string[], label: string, value: string | undefined): void {
  if (value) lines.push(`${label}: ${value}`);
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
