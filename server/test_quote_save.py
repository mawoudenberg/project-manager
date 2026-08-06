"""Regression tests for the atomic quote-save API operation."""

import os
import tempfile
import unittest

import app as project_manager


def quote_data(name):
    return {
        'name': name,
        'client': 'Test client',
        'quote_date': '2026-08-01',
        'margin': 20,
        'status': 'draft',
        'notes': '',
        'project_name': '',
        'created_by': 'Test',
        'image_data': '',
        'extras_json': '',
        'total_price': 100,
    }


def quote_item(name='Original item'):
    return {
        'type': 'material', 'name': name, 'quantity': 1, 'unit': 'st',
        'unit_price': 100, 'sort_order': 0, 'margin': None,
        'is_outsourced': 0, 'enabled': 1,
    }


class QuoteSaveTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        project_manager.DB_PATH = os.path.join(self.tmpdir.name, 'test.db')
        project_manager.init_db()
        self.client = project_manager.app.test_client()

    def tearDown(self):
        self.tmpdir.cleanup()

    def save(self, payload):
        return self.client.post('/api/query', json={
            'action': 'save_quote', 'table': 'quotes', 'data': payload,
        })

    def query(self, table, where=None):
        return self.client.post('/api/query', json={
            'action': 'select', 'table': table, 'where': where or {},
        })

    def test_failed_update_keeps_original_quote_and_items(self):
        created = self.save({'quote': quote_data('Original quote'), 'items': [quote_item()]})
        self.assertEqual(created.status_code, 201)
        quote_id = created.get_json()['id']

        # Changing the parent and deleting its old line happen before this invalid
        # line insert.  The transaction must roll all of it back.
        failed = self.save({
            'id': quote_id,
            'quote': quote_data('Changed quote'),
            'items': [quote_item(None)],  # quote_items.name is NOT NULL
        })
        self.assertEqual(failed.status_code, 500)

        quotes = self.query('quotes', {'id': quote_id}).get_json()
        items = self.query('quote_items', {'quote_id': quote_id}).get_json()
        self.assertEqual(quotes[0]['name'], 'Original quote')
        self.assertEqual([item['name'] for item in items], ['Original item'])

    def test_failed_new_quote_creates_nothing(self):
        failed = self.save({
            'quote': quote_data('Should not persist'),
            'items': [quote_item(None)],
        })
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(self.query('quotes').get_json(), [])

    def test_variant_group_is_stored_and_can_be_cleared(self):
        grouped = quote_data('Variant A')
        grouped['variant_group'] = 'variants-test-123'
        created = self.save({'quote': grouped, 'items': [quote_item()]})
        self.assertEqual(created.status_code, 201)
        quote_id = created.get_json()['id']

        row = self.query('quotes', {'id': quote_id}).get_json()[0]
        self.assertEqual(row['variant_group'], 'variants-test-123')

        cleared = self.client.post('/api/query', json={
            'action': 'update', 'table': 'quotes',
            'data': {'variant_group': ''}, 'where': {'id': quote_id},
        })
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual(self.query('quotes', {'id': quote_id}).get_json()[0]['variant_group'], '')


if __name__ == '__main__':
    unittest.main()
