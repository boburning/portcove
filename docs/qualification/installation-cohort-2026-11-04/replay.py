#!/usr/bin/env python3
"""Replay this dated source join; performs no network reads or planning writes."""
import collections
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=HERE, text=True).strip())

def sha(value):
    return hashlib.sha256(value).hexdigest()

def git_bytes(revision, path):
    return subprocess.check_output(['git', 'show', revision + ':' + path], cwd=ROOT)

def write(name, value):
    raw = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode() if not isinstance(value, str) else value.encode()
    path = HERE / name
    raw = subprocess.check_output(['pnpm', 'exec', 'vp', 'fmt', '--stdin-filepath=' + str(path), '--threads=1'], input=raw, cwd=ROOT)
    if '--check' in sys.argv:
        assert path.read_bytes() == raw, 'Generated output differs: ' + name
    else:
        path.write_bytes(raw)

observation_raw = (HERE / 'observation.json').read_bytes()
observation = json.loads(observation_raw)
base = observation['source']
boundary_path = 'docs/qualification/installation-delivery-boundary-2026-10-25.json'
boundary_raw = git_bytes(base, boundary_path)
boundary = json.loads(boundary_raw)
historical_path = 'docs/qualification/installation-rollout-inventory-2026-10-24.json'
historical_raw = git_bytes(boundary['source_commit'], historical_path)
assert sha(historical_raw) == boundary['preserved_inventory']['sha256']
historical = json.loads(historical_raw)
assert {r['id']: r['canonical_issue']['number'] for r in historical['ports']} == {r['id']: r['canonical_issue'] for r in boundary['original_inventory']}
affected = historical['affected_inventory_reconciliation']
assert {r['id']: r['canonical_issue'] for r in affected['affected_authored_additions']} == {r['id']: r['canonical_issue'] for r in boundary['affected_additions']}
assert affected['unresolved_roadmap_only_joins'] == boundary['roadmap_only_joins']
assert affected['known_duplicate_mappings'] == boundary['duplicate_mappings']
assert observation['repository'] == 'boburning/portcove'
assert observation['repository_node_id'] == 'R_kgDOUL3Beg'
assert observation['project_id'] == 'PVT_kwHOApLVys4BiZPj'
issues = observation['issues']
items = observation['items']
assert len({x['id'] for x in issues}) == len({x['number'] for x in issues}) == len(issues) == 2059
assert len({x['id'] for x in items}) == len({x['issue_id'] for x in items}) == len(items) == 2059
assert sum(not x['isArchived'] for x in items) == 2058
assert sum(x['isArchived'] for x in items) == 1
assert observation['body_reads'] == len(issues)
issue_by_number = {x['number']: x for x in issues}
item_by_number = {x['issue_number']: x for x in items}
for item in items:
    assert item['issue_id'] == issue_by_number[item['issue_number']]['id']

prefix = 'crates/portcove-core/catalog/ports/'
paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', base, '--', prefix], cwd=ROOT, text=True).splitlines()
request = ''.join(base + ':' + path + '\n' for path in paths).encode()
result = subprocess.check_output(['git', 'cat-file', '--batch'], input=request, cwd=ROOT)
records = {}
by_issue = collections.defaultdict(list)
offset = 0
for path in paths:
    end = result.index(b'\n', offset)
    object_id, kind, size = result[offset:end].decode().split()
    assert kind == 'blob'
    offset = end + 1
    raw = result[offset:offset + int(size)]
    offset += int(size) + 1
    record = json.loads(raw)
    key = record['listing']['id']
    assert key not in records
    records[key] = (path, raw, record)
    by_issue[record['listing'].get('issue_number')].append(key)
assert offset == len(result)

# These are retained canonical conditions, not newly invented deferrals.
unlisted = {
    2728: 'Original-decompilation provenance, accepted ROM identity and complete build contract remain unresolved; firmware placeholder is not an accepted BIOS requirement.',
    2744: 'Android provenance and distribution grant remain unresolved; own SNES original does not grant translated-code/APK rights. No Desktop APK operation is admitted.',
    2757: 'Cancelled XBLA remaster has no accepted lawful exact-input route; the retail N64 edition is a different identity.',
    2761: 'Retired frontend and named successor retain exact source/build/maintenance conditions; successor is not a separately qualified replacement Desktop player.',
    2791: 'RevoSucks-fork source/bundled-game acquisition hold remains; README exclusion text does not independently establish changed permission or accepted input.',
}
cohorts = [('original524', boundary['original_inventory']), ('affected312', boundary['affected_additions']), ('roadmap22', boundary['roadmap_only_joins'])]
rows = []
for cohort, members in cohorts:
    assert len(members) == {'original524': 524, 'affected312': 312, 'roadmap22': 22}[cohort]
    for member in members:
        number = member.get('canonical_issue', member.get('number'))
        key = member.get('id')
        if cohort == 'roadmap22':
            joined = by_issue[number]
            assert len(joined) <= 1
            key = joined[0] if joined else None
        issue = issue_by_number[number]
        item = item_by_number[number]
        row = {'cohort': cohort, 'frozen_identity': member.get('id', member.get('identity')), 'issue': number, 'issue_url': f'https://github.com/boburning/portcove/issues/{number}', 'observed_issue_state': issue['state'], 'observation_join': number, 'authored_id': key}
        if key:
            path, raw, record = records[key]
            listing = record['listing']
            assert listing['issue_number'] == number
            integration = record.get('integration')
            guide = listing.get('manual_setup')
            provider = integration.get('release', {}).get('provider', 'github') if integration else None
            route = 'authored-managed-package-policy' if integration else 'listing-only'
            replacement = 'Core managed policy; operation qualification is separate' if integration else 'No runtime replacement operation declared'
            trust_policies = {}
            if provider == 'user-prepared':
                for platform, policy in integration['release']['user_prepared'].items():
                    trust = policy.get('trust', 'official-package')
                    assert trust in ('user-selected', 'official-package')
                    trust_policies[platform] = trust
                    if trust == 'user-selected':
                        assert policy['archive_name'] == policy['archive_sha256'] == policy['immutable_tree_sha256'] == policy['executable'] == ''
                        assert policy['archive_size'] == 0
                    else:
                        assert len(policy['archive_sha256']) == len(policy['immutable_tree_sha256']) == 64
                assert trust_policies
                if set(trust_policies.values()) == {'user-selected'}:
                    route = 'authored-user-selected-executable-registration'
                    replacement = 'Player/upstream; Core records selected executable/CWD/arguments and execution intent, without package/tree certification'
                elif set(trust_policies.values()) == {'official-package'}:
                    route = 'authored-exact-user-prepared-inspection'
                    replacement = 'Player/upstream; Core inspects retained exact package/tree'
                else:
                    route = 'authored-mixed-user-prepared-policies-by-platform'
                    replacement = 'Player/upstream; Core inspection follows each declared platform trust policy'
            if guide and not integration:
                route = 'prepared-copy-presentation; conditional admission facts remain canonical'
                replacement = 'Player/upstream for any independently permitted external copy'
            row.update({'record_path': path, 'record_sha256': sha(raw), 'source_url': f'https://github.com/boburning/portcove/blob/{base}/{path}', 'project_url': listing['project_url'], 'authored_route': route, 'provider': provider, 'user_prepared_trust_by_platform': trust_policies, 'adapter': integration.get('adapter') if integration else None, 'runtime_replacement_owner': replacement, 'declared_platforms': integration.get('platforms', []) if integration else listing.get('platforms', []), 'setup_guide_sha256': sha(json.dumps(guide, ensure_ascii=False, separators=(',', ':')).encode()) if guide else None, 'source_profile': integration.get('source_profile') if integration else None, 'bios_source_profile': integration.get('bios_source_profile') if integration else None, 'declared_source_requirements': integration.get('presentation', {}).get('source_requirements', []) if integration else [], 'remaining_acceptance': 'Canonical acceptance unchanged; not reassessed'})
        else:
            assert number in unlisted and cohort == 'roadmap22'
            row.update({'authored_route': 'source-absent; retained canonical hold', 'runtime_replacement_owner': 'No new runtime replacement admitted', 'remaining_acceptance': unlisted[number]})
        rows.append(row)
assert len(rows) == len({r['issue'] for r in rows}) == 858
assert sum(r['authored_id'] is not None for r in rows) == 853
assert {r['issue'] for r in rows if r['authored_id'] is None} == set(unlisted)
assert sum(r['authored_route'] == 'authored-user-selected-executable-registration' for r in rows) == 80
assert {r['authored_id'] for r in rows if r['authored_route'] == 'authored-exact-user-prepared-inspection'} == {'dkc2-recomp', 'super-mario-bros-remastered', 'wave-race-64-recomp'}
assert boundary['duplicate_mappings'] == [{'from': 554, 'to': 356}, {'from': 1786, 'to': 322}]
for mapping in boundary['duplicate_mappings']:
    assert mapping['from'] in issue_by_number and mapping['to'] in issue_by_number
    assert mapping['from'] in item_by_number and mapping['to'] in item_by_number
summary = {'frozen_identities': 858, 'original_authored_present': 524, 'affected_authored_present': 312, 'roadmap_joins_authored': 17, 'roadmap_joins_source_absent': 5, 'missing_canonical_issues': 0, 'missing_project_items': 0, 'changed_original_authored_owner_bindings': 0, 'observed_issue_states': dict(sorted(collections.Counter(r['observed_issue_state'] for r in rows).items())), 'substantive_port_changes': 0, 'fully_completed_title_outcomes': 0, 'direct_required_beta_outcomes_resolved': 0, 'whole_parent_or_cohort_outcomes_closed': 0}
report = {'format_version': 1, 'kind': 'dated-preserved-cohort-identity-source-join-not-live-planning-or-fit-authority', 'owner': 2926, 'parent': 2510, 'source': base, 'observation_time': observation['observed_at'], 'observation_file_sha256': sha(observation_raw), 'boundary_file_sha256': sha(boundary_raw), 'historical_inventory_sha256': sha(historical_raw), 'historical_inventory_source': boundary['source_commit'], 'duplicate_mappings': boundary['duplicate_mappings'], 'historical_316_identities_317_rows': 'Overlapping historical cohort; not another summand and not requalified by this join.', 'summary': summary, 'claims': {'identity_and_source_accounting': 'All858 frozen identities joined at the stated source and dated observation.', 'per_port_fit_and_maintenance': 'Not reassessed; unfinished #2926 acceptance remains canonical.', 'native_protected_gameplay_release_or_supported': 'Not evaluated; no new execution or publication.', 'closure': 'No title, Required outcome or whole parent/cohort closes from this report.'}, 'rows': rows}
write('reconciliation.json', report)
print(json.dumps(summary, sort_keys=True))

def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')

lines = [
    '# Preserved installation cohort identity reconciliation — November 4, 2026',
    '',
    f'This dated component for [#2926](https://github.com/boburning/portcove/issues/2926) joins the original **524 + 312 + 22 = 858 identities** to source `{base}` and the complete maintained Roadmap observation at `{observation["observed_at"]}`. It completes the source/identity-accounting component of acceptance criterion 1. Per-port applicability, maintenance, required fitting changes and final parent acceptance remain unfinished.',
    '',
    '**No substantive port change, new complete title outcome, direct Required-beta outcome or whole parent/cohort closure is claimed.** The 508 CLOSED / 350 OPEN issue states are dated planning observations, not qualified/blocked totals. A guide, adapter, exact user-prepared inspection policy and managed package policy have different ownership meanings; none establishes actual native, protected, gameplay, real-save, installed-client or Supported acceptance.',
    '',
    '## Scope and evidence',
    '',
    '- All 836 original/affected authored IDs exist, retain their original canonical issue bindings and join current Project membership. The 22 original roadmap joins resolve to 17 authored entries and five intentionally source-absent identities. Those five retain their named conditions below; no listing, payload or replacement identity is invented.',
    '- The immutable original inventory SHA-256 is `' + sha(historical_raw) + '`. The replay reads the historical Git blob and frozen boundary directly, then checks exact identities, counts and owner bindings. The historical 316 identities / 317 rows overlap this scope and are not added to it. Preserve #554→#356 and #1786→#322 as historical duplicate lineage.',
    '- The successful collection used `collectRoadmapInventory` and `requireRoadmapInventory` in the same process, with complete stable repository pagination, independent active/archived Project coverage, opaque identities, counts, body reads and revision/freshness guards. It observed 2,059 issues and 2,058 active plus one archived Project item. The archived item is #1730; it is outside this frozen cohort. GitHub defaults Project item reads to non-archived items; see the [Projects schema](https://docs.github.com/en/graphql/reference/projects#projectv2).',
    '- An earlier collection was inconclusive because the Project revision changed despite an unchanged item count. Its failure is retained in observation provenance; it supplies no completeness claim. The later successful capture is separate evidence. The reduced replay input preserves all issue/Project opaque joins, cohort body hashes, observation times and observed fields. The full original capture hash is retained; replay does not recreate a live API traversal or revalidate current planning.',
    '- `body_observation_sha256` follows the maintained collector convention, hashing `JSON.stringify(body)`. `body_utf8_sha256` hashes UTF-8 body bytes. These conventions are distinct. The replay retains the observed hashes; canonical issue bodies can subsequently change.',
    '- Provider and replacement-owner labels describe authored policy only. The 80 `trust: user-selected` definitions retain executable-intent registration, without package/tree certification; only DKC2, SMBRemastered and Wave Race retain exact package/tree inspection. These policies remain distinct even though both use the `user-prepared` provider. Shared source-profile IDs, setup-guide hashes and exact source links preserve where the source/setup declarations can be reviewed. They do not certify a particular package, original, runtime, permission grant or operation. Every canonical acceptance and known failure remains binding.',
    '',
    '## Reproduction',
    '',
    'From a checkout containing the two retained Git commits, run:',
    '',
    '```sh',
    'python3 docs/qualification/installation-cohort-2026-11-04/replay.py --check',
    '```',
    '',
    'Without `--check`, the same script regenerates `reconciliation.json` and this report from the committed `observation.json`, the frozen historical boundary/inventory and the exact authored source tree. It uses the repository-pinned formatter and performs no network reads or planning writes. The observation is dated evidence, never a new live backlog, fit registry or publication authority.',
    '',
    '## Compact member table',
    '',
    'Every row has the same change and validation scope: exact identity/source/owner join only, using the replay assertions and maintained inventory capture. Detailed source facts, source hashes, dated Project observations and issue-body hashes are in [the machine-readable reconciliation](reconciliation.json). Each source link identifies the complete authored record, including source/setup and qualification declarations. Remaining canonical acceptance was not reassessed; none can close because of this delivery. Already closed owners stay closed.',
    '',
    '| Canonical port / issue | Actual authored route / provider | Source evidence | Remaining limitation / new closure |',
    '| --- | --- | --- | --- |',
]
for row in rows:
    identity = row['authored_id'] or '/'.join(row['frozen_identity']['portKeys'])
    port = f'[{cell(identity)} #{row["issue"]}]({row["issue_url"]})'
    route = row['authored_route'] if row.get('provider') == 'user-prepared' else row.get('adapter') or row['authored_route']
    if row.get('provider'):
        route += ' / ' + row['provider']
    evidence = f'[Exact record]({row["source_url"]})' if row.get('source_url') else 'No authored record; retained canonical hold'
    limitation = 'Canonical acceptance unchanged; no new closure' if row['authored_id'] else row['remaining_acceptance'] + ' No closure.'
    lines.append('| ' + ' | '.join([port, cell(route), evidence, cell(limitation)]) + ' |')
write('report.md', '\n'.join(lines) + '\n')
