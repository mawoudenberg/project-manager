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


if __name__ == '__main__':
    unittest.main()
