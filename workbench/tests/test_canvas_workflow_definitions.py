import json
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.db import close_old_connections
from django.test import Client, TransactionTestCase, override_settings

from workbench.models import CanvasWorkflowDefinition, CanvasWorkflowRun


class CanvasWorkflowDefinitionApiTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.key = 'b' * 64
        self.auth = patch.dict(os.environ, {'TRADELOOM_NATIVE_BRIDGE_KEY': self.key})
        self.auth.start()
        self.addCleanup(self.auth.stop)
        self.url = '/api/canvas-workflow-definitions'

    def request(self, method='get', payload=None, query='', key=None, client=None):
        client = client or self.client
        headers = {'HTTP_X_TRADELOOM_NATIVE_BRIDGE': self.key if key is None else key}
        if method == 'get':
            return client.get(self.url + query, **headers)
        body = json.dumps(payload, ensure_ascii=True, separators=(',', ':'))
        return client.generic(method.upper(), self.url, body, content_type='application/json', **headers)

    def document(self, **overrides):
        return {
            'version': 1,
            'id': 'definition-1',
            'title': '工作流 😀',
            'source': 'manual',
            'confirmed': True,
            'nodes': [
                {'id': 'input', 'kind': 'input', 'title': '开始', 'instruction': 'NUL\u0000 emoji 😀'},
                {'id': 'output', 'kind': 'output', 'title': '结束'},
            ],
            'edges': [{'from': 'input', 'to': 'output'}],
            **overrides,
        }

    def post_document(self, document=None, expected=0, client=None):
        return self.request('post', {'document': document or self.document(), 'expectedRevision': expected}, client=client)

    def test_private_bridge_create_read_unicode_nul_and_digest(self):
        self.assertEqual(self.request(key='wrong').status_code, 403)
        self.assertEqual(self.post_document().status_code, 201)
        response = self.request(query='?id=definition-1')
        self.assertEqual(response.status_code, 200)
        dto = response.json()
        self.assertEqual(dto['revision'], 1)
        self.assertEqual(dto['document']['title'], '工作流 😀')
        self.assertEqual(dto['document']['nodes'][0]['instruction'], 'NUL\u0000 emoji 😀')
        self.assertRegex(dto['definitionRevision'], r'^sha256:[a-f0-9]{64}$')

    def test_draft_has_null_digest_and_agent_default_is_unconfirmed(self):
        draft = self.document(id='draft-flow', source='agent', confirmed=False)
        created = self.post_document(draft)
        self.assertEqual(created.status_code, 201)
        self.assertIsNone(created.json()['definitionRevision'])
        self.assertFalse(created.json()['document']['confirmed'])

    def test_update_stale_cas_delete_tombstone_and_recreate_prevent_aba(self):
        self.assertEqual(self.post_document().status_code, 201)
        updated_doc = self.document(title='Updated')
        updated = self.post_document(updated_doc, expected=1)
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()['revision'], 2)
        self.assertEqual(self.post_document(self.document(title='Stale'), expected=1).status_code, 409)
        deleted = self.request('delete', {'workflowId': 'definition-1', 'expectedRevision': 2})
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()['deleted'])
        self.assertEqual(deleted.json()['revision'], 3)
        repeated = self.request('delete', {'workflowId': 'definition-1', 'expectedRevision': 3})
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()['revision'], 3)
        self.assertEqual(self.request(query='?id=definition-1').json()['revision'], 3)
        self.assertEqual(self.request(query='?limit=10').json()['total'], 0)
        recreated = self.post_document(self.document(title='Recreated'), expected=3)
        self.assertEqual(recreated.status_code, 200)
        self.assertEqual(recreated.json()['revision'], 4)
        self.assertFalse(recreated.json()['deleted'])
        self.assertEqual(self.post_document(self.document(title='ABA'), expected=0).status_code, 409)

    def test_strict_request_query_and_workflow_schema_validation(self):
        self.assertEqual(self.request('post', {'document': self.document(), 'expectedRevision': 0, 'actor': 'fake'}).status_code, 400)
        self.assertEqual(self.request('post', {'document': self.document(), 'expectedRevision': True}).status_code, 400)
        self.assertEqual(self.request('delete', {'workflowId': 'definition-1', 'expectedRevision': 0, 'extra': True}).status_code, 400)
        self.assertEqual(self.request(query='?id=bad&id=duplicate').status_code, 400)
        invalid = self.document(unexpected='field')
        self.assertEqual(self.post_document(invalid).json()['code'], 'invalid_workflow')
        invalid_id = self.document(id=123)
        self.assertEqual(self.post_document(invalid_id).json()['code'], 'invalid_workflow')
        self.assertFalse(CanvasWorkflowDefinition.objects.exists())

    def test_list_is_stable_paginated_and_hides_deleted(self):
        for identifier in ('gamma', 'alpha', 'beta'):
            self.assertEqual(self.post_document(self.document(id=identifier)).status_code, 201)
        first = self.request(query='?limit=2').json()
        self.assertEqual([row['workflowId'] for row in first['definitions']], ['alpha', 'beta'])
        self.assertEqual(first['total'], 3)
        self.assertEqual(first['nextOffset'], 2)
        second = self.request(query='?offset=2&limit=2').json()
        self.assertEqual([row['workflowId'] for row in second['definitions']], ['gamma'])
        self.assertIsNone(second['nextOffset'])
        self.assertEqual(self.request(query='?limit=101').status_code, 400)

    def test_historical_run_snapshot_is_not_changed_by_definition_updates(self):
        historical_document = self.document(title='Original')
        historical_document['nodes'][0]['instruction'] = 'Original non-NUL snapshot'
        frozen_definition = self.post_document(historical_document).json()
        snapshot = {'id': 'run-snapshot', 'workflowId': 'definition-1',
                    'document': frozen_definition['document'],
                    'definitionRevision': frozen_definition['definitionRevision']}
        CanvasWorkflowRun.objects.create(
            id='0e865879-90dc-4f6f-86c8-7f53adad6c9d', workflow_id='definition-1', revision=1,
            status='done', execution_mode='local_mock', snapshot=snapshot,
        )
        self.assertEqual(self.post_document(self.document(title='New'), expected=1).status_code, 200)
        run = CanvasWorkflowRun.objects.get(workflow_id='definition-1')
        self.assertEqual(run.snapshot, snapshot)
        self.assertEqual(run.snapshot['definitionRevision'], frozen_definition['definitionRevision'])

    def test_validator_configuration_failure_is_typed_unavailable(self):
        with override_settings(TRADELOOM_ARTIFACT_NODE=''):
            response = self.post_document()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()['code'], 'workflow_validation_unavailable')

    def test_concurrent_postgresql_cas_allows_only_one_update(self):
        self.assertEqual(self.post_document().status_code, 201)
        barrier = Barrier(2)

        def update(title):
            close_old_connections()
            client = Client()
            barrier.wait(timeout=5)
            response = self.post_document(self.document(title=title), expected=1, client=client)
            close_old_connections()
            return response.status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(update, ['left', 'right']))
        self.assertEqual(statuses, [200, 409])
        row = CanvasWorkflowDefinition.objects.get(pk='definition-1')
        self.assertEqual(row.revision, 2)
