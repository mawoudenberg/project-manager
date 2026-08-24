import os
import tempfile
import unittest

import app as server


class TimeEntryApiTests(unittest.TestCase):
    def setUp(self):
        handle, self.db_path = tempfile.mkstemp(suffix='.db')
        os.close(handle)
        server.DB_PATH = self.db_path
        server.init_db()
        with server.get_db() as db:
            self.project_id = db.execute(
                "INSERT INTO projects (name, status) VALUES (?, ?)",
                ('Testproject', 'active'),
            ).lastrowid
        self.client = server.app.test_client()

    def tearDown(self):
        os.unlink(self.db_path)

    def query(self, action, data=None, where=None):
        return self.client.post('/api/query', json={
            'action': action,
            'table': 'time_entries',
            'data': data or {},
            'where': where or {},
        })

    def test_create_update_and_delete_half_hour_entry(self):
        created = self.query('insert', {
            'entry_date': '2026-08-22',
            'hours': 2.5,
            'project_id': self.project_id,
            'employee': 'Maurits',
        })
        self.assertEqual(created.status_code, 201)
        entry_id = created.get_json()['id']

        updated = self.query('update', {'hours': 3.0}, {'id': entry_id})
        self.assertEqual(updated.status_code, 200)
        rows = self.query('select').get_json()
        self.assertEqual(rows[0]['hours'], 3.0)

        deleted = self.query('delete', where={'id': entry_id})
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.query('select').get_json(), [])

    def test_rejects_non_half_hour_increment(self):
        response = self.query('insert', {
            'entry_date': '2026-08-22',
            'hours': 1.25,
            'project_id': self.project_id,
            'employee': 'Maurits',
        })
        self.assertEqual(response.status_code, 500)
        self.assertIn('CHECK constraint failed', response.get_json()['error'])

    def test_non_billable_entry_uses_shared_category(self):
        categories = self.client.post('/api/query', json={
            'action': 'select', 'table': 'time_categories', 'data': {}, 'where': {},
        })
        self.assertEqual(categories.status_code, 200)
        names = [row['name'] for row in categories.get_json()]
        self.assertEqual(names, [
            'Offertes maken', 'Administratie', 'Acquisitie',
            'Werkplaats / Onderhoud', 'Overig',
        ])
        category_id = categories.get_json()[0]['id']
        created = self.query('insert', {
            'entry_date': '2026-08-24',
            'hours': 1.5,
            'project_id': None,
            'category_id': category_id,
            'employee': 'George',
        })
        self.assertEqual(created.status_code, 201)
        row = self.query('select').get_json()[0]
        self.assertIsNone(row['project_id'])
        self.assertEqual(row['category_id'], category_id)

    def test_entry_requires_project_or_category_but_not_both(self):
        with server.get_db() as db:
            category_id = db.execute('SELECT id FROM time_categories ORDER BY id LIMIT 1').fetchone()[0]
        neither = self.query('insert', {
            'entry_date': '2026-08-24', 'hours': 1, 'project_id': None,
            'category_id': None, 'employee': 'Maurits',
        })
        both = self.query('insert', {
            'entry_date': '2026-08-24', 'hours': 1, 'project_id': self.project_id,
            'category_id': category_id, 'employee': 'Maurits',
        })
        self.assertEqual(neither.status_code, 500)
        self.assertEqual(both.status_code, 500)


if __name__ == '__main__':
    unittest.main()
