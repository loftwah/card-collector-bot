"""Disposable SQLite checks for the unnumbered Discord registry proposal.

These do not substitute for D1 remote migration timing or transaction proof.
"""
import pathlib
import sqlite3
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL = (ROOT / 'docs/pending/discord-global-binding-guard.sql').read_text()


def statements(sql):
    text = ''
    for line in sql.splitlines(keepends=True):
        text += line
        if sqlite3.complete_statement(text):
            yield text
            text = ''
    if text.strip():
        raise AssertionError('incomplete SQL')


def migrate(db):
    db.execute('BEGIN')
    try:
        for statement in statements(SQL):
            db.execute(statement)
        db.commit()
    except Exception:
        db.rollback()
        raise


def fixture():
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE fb_discord_identities (id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, user_id TEXT NOT NULL, revoked_at TEXT)')
    db.execute('CREATE TABLE fb_users (id TEXT PRIMARY KEY,email TEXT NOT NULL)')
    db.execute('CREATE TABLE fb_memberships (user_id TEXT NOT NULL)')
    db.execute('CREATE TABLE fb_wallets (user_id TEXT NOT NULL)')
    return db


class MigrationTest(unittest.TestCase):
    def test_conflicting_historical_accounts_abort_all_schema_changes(self):
        db = fixture()
        db.executemany('INSERT INTO fb_discord_identities VALUES (?,?,?,?)', [('a','discord','one',None),('b','discord','two','revoked')])
        db.commit()
        with self.assertRaises(sqlite3.OperationalError):
            migrate(db)
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='fb_discord_global_bindings'").fetchone())
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='fb_discord_identity_global_lookup_idx'").fetchone())
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fb_discord_identities').fetchone()[0], 2)

    def test_backfill_includes_revoked_mappings(self):
        db = fixture()
        db.executemany('INSERT INTO fb_discord_identities VALUES (?,?,?,?)', [('a','one','person',None),('b','one','person','revoked'),('c','two','other','revoked')])
        db.commit()
        migrate(db)
        self.assertEqual(db.execute('SELECT discord_user_id,user_id FROM fb_discord_global_bindings ORDER BY discord_user_id').fetchall(), [('one','person'),('two','other')])

    def test_small_local_backfill_measurement(self):
        db = fixture()
        db.executemany('INSERT INTO fb_discord_identities VALUES (?,?,?,?)', ((str(i),f'discord_{i}',f'person_{i}',None) for i in range(10000)))
        db.commit()
        started = time.monotonic()
        migrate(db)
        elapsed = time.monotonic() - started
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fb_discord_global_bindings').fetchone()[0], 10000)
        print(f'Local in-memory SQLite backfill: 10,000 synthetic bindings in {elapsed:.3f}s; not a remote D1 latency estimate')

    def test_cap_rejects_before_any_schema_change(self):
        db = fixture()
        db.executemany('INSERT INTO fb_discord_identities VALUES (?,?,?,?)', ((str(i),f'discord_{i}',f'person_{i}',None) for i in range(10001)))
        db.commit()
        with self.assertRaises(sqlite3.OperationalError):
            migrate(db)
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='fb_discord_identity_global_lookup_idx'").fetchone())
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fb_discord_identities').fetchone()[0], 10001)


if __name__ == '__main__':
    unittest.main()
