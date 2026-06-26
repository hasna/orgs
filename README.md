# open-orgs

Open organization graph and delegation context for agentic systems.

`open-orgs` is a local-first graph layer for humans, agents, service accounts,
teams, functions, roles, projects, machines, capabilities, reporting lines, and
delegation authority.

It does not replace identity, project, machine, session, dispatch, action,
guardrail, todo, or event systems. It stores typed refs to those systems and
answers context questions such as:

- Who am I?
- Who do I report to?
- Who can I delegate this capability or project to?
- Which teams/functions own this area?
- Which machines and dispatch targets are assigned to this work?

## Install

`@hasna/orgs` is not currently published on the public npm registry. A registry
check on 2026-06-26 returned `E404`, so do not use `bun install -g @hasna/orgs`
as verified install guidance until an authorized publish has happened and the
registry check succeeds.

Use a checkout for now:

```bash
bun install
bun run build
bun run src/cli.ts status
```

Release verification:

```bash
bun run verify:release
bun run verify:published
```

`verify:published` is expected to fail with `E404` until the package is actually
published. Do not publish from this repository without explicit permission and
confidence in the release contents.

## CLI

```bash
orgs init
orgs orgs add --name "Open Maintainers"
orgs teams add --org open-maintainers --name "Core"
orgs agents add --org open-maintainers --name "Review Agent" --identity agent:review-agent
orgs capabilities add --org open-maintainers --namespace repo --key review
orgs relationships add --kind delegates_to --from member:review-agent --to member:build-agent --authority execute
orgs snapshot review-agent --format markdown
orgs resolve --actor review-agent --capability repo:review --json
orgs validate --json
```

Global flags:

- `--store <path>` uses an isolated local graph file.
- `--audit <path>` uses an isolated audit JSONL file.
- `--json` returns stable JSON output.
- `--verbose` adds extra human-readable fields without switching to raw object
  dumps.
- `--limit <n>` and `--cursor <offset>` page human list/validation/resolve
  output. Human list output defaults to the first 20 records.
- `--filter <text>` narrows list output by ID, slug, name, kind, and related
  record text.

CLI output uses gradual disclosure by default. Human `list`, `status`,
`validate`, `resolve`, and `show` commands print compact summaries with hints
for the next detail command. Use `<group> show <id>` for focused detail,
`--verbose` for more human fields, and `--json` for full machine-readable
records. Existing `--json <group> list` calls still return the full JSON array;
when `--json` is combined with explicit `--limit` or `--cursor`, the CLI returns
`{ "records": [...], "page": { ... } }` for machine-readable pagination.

Data is stored in `~/.hasna/orgs/orgs.json` by default. Set
`OPEN_ORGS_STORE` and `OPEN_ORGS_AUDIT` to override the default store and audit
paths. `orgs status` reports metadata-only evidence when a legacy or alternate
SQLite `orgs.db` exists beside a missing or empty JSON store; it does not read
or migrate SQLite contents automatically.

## Model

The graph uses stable prefixed IDs and typed records:

- `org_*`: organizations with optional parent organizations.
- `team_*`: teams with optional parent teams and business-function links.
- `func_*`: business functions.
- `role_*`: scoped roles and responsibilities.
- `mem_*`: humans, agents, and service accounts, linked to
  `open-identities`.
- `proj_*`: project refs, linked to `open-projects`.
- `mach_*`: machine refs and dispatch evidence, linked to `open-machines`,
  `open-sessions`, and `open-dispatch`.
- `cap_*`: capability ownership records.
- `rel_*`: typed relationships with source, target, scope, authority,
  provenance, confidence, valid-from, expiry, and revocation fields.

Relationships are first-class because delegation must be explainable and
revocable. A `delegates_to` edge can be scoped to a project, machine, team,
function, capability, or external policy/action reference.

## Snapshots

`orgs snapshot <member>` emits concise JSON or Markdown for an agent:

- identity ref and status
- org/team/role context
- responsibilities and capabilities
- reporting path
- allowed delegation targets
- related projects
- machine assignments and dispatch evidence
- policy context refs
- warnings for stale refs or unavailable dispatch targets

Snapshots strip external metadata and never include identity documents, contact
values, secrets, or raw private source payloads.

## Examples

Import an example into an isolated store:

```bash
orgs --store /tmp/open-orgs.json import examples/small-oss-org.json
orgs --store /tmp/open-orgs.json snapshot mem_review_agent --format markdown
```

Available examples:

- `examples/small-oss-org.json`
- `examples/parent-orgs.json`
- `examples/machine-project-delegation.json`

## Integration Notes

See [docs/integrations.md](docs/integrations.md) for the ownership matrix and
bridge notes for `open-identities`, `open-projects`, `open-machines`,
`open-sessions`, `open-dispatch`, `open-todos`, `open-events`, `open-actions`,
and `open-guardrails`.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run --ignore-scripts
```
