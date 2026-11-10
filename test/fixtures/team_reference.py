"""Independent Python fixtures for Ardent's published team wire contract.

These are test peers, not a copy of the optional Hermes team plugin. The pinned
Hermes protocol module still supplies the real message/task wire encoding.
"""
import hashlib
import json
import re
import sqlite3
import time
import uuid

METADATA_KEY = 'hermesTeamTask'
CLARIFICATION_KEY = 'hermesTeamClarification'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def build_envelope(mission, caller, task_id, objective):
    return {'version': '1.0', 'caller': caller, 'task_id': task_id,
            'objective': objective, 'mission': mission}


def validate_result(text, envelope):
    text = re.sub(r'^\[INPUT_REQUIRED\]\s*', '', text.strip())
    if text.startswith('```json\n') and text.endswith('\n```'):
        text = text[8:-4]
    value = json.loads(text)
    mission = envelope['mission']
    assert value['version'] == '1.0'
    assert (value['mission_id'], value['mission_revision'], value['task_id']) == (
        mission['id'], mission['revision'], envelope['task_id'])
    assert value['outcome'] in {'completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown'}
    criteria = {check['criterion'] for check in value['checks']}
    assert len(criteria) == len(value['checks']) and criteria <= set(mission['acceptance_criteria'])
    if 'clarification' in value:
        assert value['outcome'] == 'input_required'
        assert value['clarification']['blocked_task'] == envelope['task_id']
    if value['outcome'] == 'completed':
        assert criteria == set(mission['acceptance_criteria'])
        assert all(check['status'] == 'pass' and check['evidence'] for check in value['checks'])
        assert set(mission['expected_artifacts']) <= {item['name'] for item in value['artifacts']}
        assert not value['uncertain_effects']
    return value


def validate_ardent_card(card, *, authenticated, source_digest, task_policy_digest):
    meta = card['metadata']['hermesTeam']
    valid = (authenticated and meta['runtimeKind'] == 'ardent'
             and meta['missionContractVersions'] == ['1.0']
             and meta['lifecycleProtocolVersions'] == ['1.0']
             and meta['coordinationProtocolVersions'] == []
             and meta['sourceDigest'] == source_digest
             and meta['taskPolicyDigest'] == task_policy_digest
             and re.fullmatch(r'[a-f0-9]{64}', source_digest)
             and re.fullmatch(r'[a-f0-9]{64}', task_policy_digest)
             and meta['discovery']['observedAt'] <= time.time() < meta['discovery']['expiresAt'])
    if not valid:
        raise ValueError('Untrusted or incompatible Ardent discovery card')


def lifecycle_call(request, action, payload, key):
    control = {'version': '1.0', 'action': action, 'key': key, 'payload': payload}
    task = request(None, 'assistant', 'SendMessage', {'message': {
        'messageId': 'control-' + uuid.uuid4().hex, 'contextId': 'control-' + uuid.uuid4().hex,
        'role': 'ROLE_USER', 'parts': [{'text': 'HERMES_COORDINATION_CONTROL'}],
        'metadata': {'hermesTeamControl': control}}})
    texts = [part['text'] for artifact in task['artifacts'] for part in artifact['parts'] if 'text' in part]
    assert len(texts) == 1, 'Control must return exactly one retained receipt'
    receipt = json.loads(texts[0])
    assert receipt['version'] == '1.0' and receipt['request_digest'] == digest(control)
    return receipt['data']


class RootFixture:
    """Transactional reference root: exact grants and idempotent child settlement."""
    def __init__(self, home):
        self.path = home / 'reference-root.sqlite'
        with self.db() as db:
            db.executescript('''
                CREATE TABLE children (id TEXT PRIMARY KEY, grant_json TEXT NOT NULL,
                    state TEXT NOT NULL, claim_id TEXT, settlement_json TEXT);
                CREATE TABLE requests (key TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt_json TEXT NOT NULL);
            ''')

    def db(self):
        return sqlite3.connect(self.path, timeout=5)

    def reserve(self, name):
        child_id = 'child-' + name
        mission = {'id': 'mission-root', 'revision': 1, 'parent_task': 'parent-root',
                   'constraints': ['Use only observed evidence'], 'allowed_actions': ['observe', 'analyze'],
                   'resources': ['public:news'], 'deadline': int(time.time()) + 300,
                   'acceptance_criteria': ['Cite a retrieved source'], 'expected_artifacts': []}
        grant = {'version': '1.0', 'root': 'coordinator', 'child_id': child_id, 'target': 'assistant',
                 'parent_task': mission['parent_task'], 'context': 'context-' + name,
                 'envelope': build_envelope(mission, 'peerb', child_id, 'Inspect public news evidence'),
                 'budget_id': 'budget-' + name, 'depth': 1, 'deadline': mission['deadline']}
        grant['sha256'] = digest(grant)
        with self.db() as db:
            db.execute('INSERT INTO children(id,grant_json,state) VALUES (?,?,?)',
                       (child_id, canonical(grant), 'reserved'))
        return grant

    def status(self, child_id):
        with self.db() as db:
            row = db.execute('SELECT grant_json,state,settlement_json FROM children WHERE id=?', (child_id,)).fetchone()
        assert row
        grant, state, settled = row
        value = {'state': state}
        if settled:
            value.update(json.loads(settled))
            value['result_registration'] = {key: json.loads(grant)[key] for key in ('budget_id', 'depth')}
        return value

    def process(self, control):
        assert control['version'] == '1.0'
        fingerprint = digest(control)
        payload = control['payload']
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT digest,receipt_json FROM requests WHERE key=?', (control['key'],)).fetchone()
            if prior:
                assert prior[0] == fingerprint, 'Request key bound to different content'
                return json.loads(prior[1])
            row = db.execute('SELECT grant_json,state,claim_id FROM children WHERE id=?', (payload['child_id'],)).fetchone()
            assert row, 'Child was not reserved'
            grant, state, claim_id = json.loads(row[0]), row[1], row[2]
            if control['action'] == 'claim_child':
                assert payload['grant_sha256'] == grant['sha256'], 'Grant digest differs'
                assert grant['deadline'] > time.time(), 'Grant expired'
                assert state == 'reserved' or (state == 'claimed' and claim_id == payload['claim_id'])
                db.execute('UPDATE children SET state=?,claim_id=? WHERE id=?', ('claimed', payload['claim_id'], payload['child_id']))
                data = {'grant': grant, 'state': 'claimed', 'claim_id': payload['claim_id']}
            elif control['action'] == 'settle_child':
                assert state == 'claimed' and payload['claim_id'] == claim_id, 'Settlement lacks exact claim'
                assert payload['native_id'] and payload['outcome'] in {'completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown'}
                data = {'native_id': payload['native_id'], 'status': payload['outcome']}
                db.execute('UPDATE children SET state=?,settlement_json=? WHERE id=?', ('settled', canonical(data), payload['child_id']))
            else:
                raise ValueError('Unsupported reference-root action')
            receipt = {'version': '1.0', 'request_digest': fingerprint, 'data': data}
            db.execute('INSERT INTO requests VALUES (?,?,?)', (control['key'], fingerprint, canonical(receipt)))
            return receipt
