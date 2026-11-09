import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

test('recycle actor migration preserves historic rows and attributes only new receipts',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE fb_recycle_receipts(id TEXT PRIMARY KEY,tenant_id TEXT,user_id TEXT,instance_id TEXT,credit_amount INTEGER,created_at TEXT,idempotency_key TEXT);
      CREATE TABLE fb_card_instances(id TEXT,tenant_id TEXT,user_id TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE fb_instance_history(id TEXT,tenant_id TEXT,instance_id TEXT,event TEXT,from_user_id TEXT,to_user_id TEXT,reference_type TEXT,reference_id TEXT,metadata_json TEXT,created_at TEXT);
      CREATE TABLE fb_wallets(tenant_id TEXT,user_id TEXT,balance INTEGER,updated_at TEXT);
      CREATE TABLE fb_ledger_entries(id TEXT,tenant_id TEXT,user_id TEXT,kind TEXT,amount INTEGER,balance_after INTEGER,reference_type TEXT,reference_id TEXT,description TEXT,idempotency_key TEXT,metadata_json TEXT,actor_type TEXT,actor_id TEXT,created_at TEXT);
      CREATE TRIGGER recycle_apply AFTER INSERT ON fb_recycle_receipts BEGIN SELECT 1; END;
      INSERT INTO fb_recycle_receipts VALUES('old','t','u','old-card',10,'before','old-key');
      INSERT INTO fb_ledger_entries VALUES('old-ledger','t','u','recycle',10,10,'recycle','old','historic','old-key','{}','user','u','before');
      INSERT INTO fb_card_instances VALUES('new-card','t','u','owned','before');
      INSERT INTO fb_wallets VALUES('t','u',10,'before');`);
    const old=JSON.stringify(db.prepare("SELECT * FROM fb_ledger_entries WHERE id='old-ledger'").get());
    db.exec(readFileSync('migrations/0036_recycle_actor.sql','utf8'));
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM fb_ledger_entries WHERE id='old-ledger'").get()),old);
    db.exec("INSERT INTO fb_recycle_requests VALUES('t','u','new-key','new-card',4,'pending','after','after');");
    db.prepare("INSERT INTO fb_recycle_receipts(id,tenant_id,user_id,instance_id,credit_amount,created_at,idempotency_key,actor_type,actor_id) VALUES('new','t','u','new-card',4,'after','new-key','agent','agent-one')").run();
    assert.deepEqual({...db.prepare("SELECT actor_type,actor_id,balance_after FROM fb_ledger_entries WHERE reference_id='new'").get()},{actor_type:'agent',actor_id:'agent-one',balance_after:14});
    assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM fb_instance_history WHERE reference_id='new'").get().metadata_json).actor_id,'agent-one');
    db.exec("INSERT INTO fb_card_instances VALUES('legacy-card','t','u','owned','before');");
    assert.throws(()=>db.exec("INSERT INTO fb_recycle_receipts(id,tenant_id,user_id,instance_id,credit_amount,created_at,idempotency_key) VALUES('legacy','t','u','legacy-card',2,'after','legacy-key')"),/recycle_request_unavailable/);
    assert.equal(db.prepare("SELECT status FROM fb_card_instances WHERE id='legacy-card'").get().status,'owned');
    db.exec("INSERT INTO fb_recycle_requests VALUES('t','u','cancelled-key','legacy-card',2,'pending','after','after'); UPDATE fb_recycle_requests SET status='cancelled' WHERE idempotency_key='cancelled-key';");
    assert.throws(()=>db.exec("UPDATE fb_recycle_requests SET status='pending' WHERE idempotency_key='cancelled-key'"),/recycle_request_immutable/);
    assert.throws(()=>db.exec("INSERT INTO fb_recycle_receipts(id,tenant_id,user_id,instance_id,credit_amount,created_at,idempotency_key) VALUES('cancelled','t','u','legacy-card',2,'after','cancelled-key')"),/recycle_request_unavailable/);
  } finally {db.close();}
});
