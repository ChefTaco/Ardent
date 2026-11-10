"""Negative and recovery checks for the independent team wire fixtures."""
import copy
import tempfile
import unittest
from pathlib import Path
from team_reference import RootFixture, build_envelope, validate_result


class RootTransactions(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.root = RootFixture(Path(self.home.name))
        self.grant = self.root.reserve('test')
        self.claim = {'version': '1.0', 'action': 'claim_child', 'key': 'claim', 'payload': {
            'child_id': self.grant['child_id'], 'grant_sha256': self.grant['sha256'], 'claim_id': 'claim-test'}}

    def test_exact_claim_is_retained_and_replayed_without_change(self):
        receipt = self.root.process(self.claim)
        self.assertEqual(self.root.process(self.claim), receipt)
        self.assertEqual(receipt['data']['grant'], self.grant)
        changed = copy.deepcopy(self.claim)
        changed['payload']['claim_id'] = 'different'
        with self.assertRaises(AssertionError):
            self.root.process(changed)

    def test_forged_grant_cannot_claim_a_budget(self):
        self.claim['payload']['grant_sha256'] = '0' * 64
        with self.assertRaises(AssertionError):
            self.root.process(self.claim)
        self.assertEqual(self.root.status(self.grant['child_id']), {'state': 'reserved'})

    def test_settlement_requires_claim_and_survives_database_reopen(self):
        settle = {'version': '1.0', 'action': 'settle_child', 'key': 'settle', 'payload': {
            'child_id': self.grant['child_id'], 'claim_id': 'claim-test', 'native_id': 'native-test',
            'result': 'No source', 'outcome': 'failed'}}
        with self.assertRaises(AssertionError):
            self.root.process(settle)
        self.root.process(self.claim)
        receipt = self.root.process(settle)
        # Each call opens the retained database, including after a completed transaction.
        self.assertEqual(self.root.process(settle), receipt)
        status = self.root.status(self.grant['child_id'])
        self.assertEqual(status['native_id'], 'native-test')
        self.assertEqual(status['result_registration'], {'budget_id': self.grant['budget_id'], 'depth': self.grant['depth']})
        self.assertEqual(status['state'], 'settled')


class ResultBindings(unittest.TestCase):
    def test_result_cannot_claim_another_task_or_unproven_completion(self):
        import json
        mission = {'id': 'mission', 'revision': 1, 'acceptance_criteria': ['Evidence'], 'expected_artifacts': []}
        envelope = build_envelope(mission, 'coordinator', 'task', 'Read evidence')
        value = {'version': '1.0', 'mission_id': 'mission', 'mission_revision': 1, 'task_id': 'task',
                 'outcome': 'partial', 'checks': [], 'artifacts': [], 'uncertain_effects': []}
        self.assertEqual(validate_result(json.dumps(value), envelope), value)
        value['task_id'] = 'another'
        with self.assertRaises(AssertionError):
            validate_result(json.dumps(value), envelope)
        value.update(task_id='task', outcome='completed')
        with self.assertRaises(AssertionError):
            validate_result(json.dumps(value), envelope)
