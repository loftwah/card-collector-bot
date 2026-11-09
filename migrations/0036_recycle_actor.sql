-- Attribute only future recycle receipts. Existing receipts and ledger rows are
-- retained unchanged. Drain old workers before applying: receipt inserts now
-- require a matching pending reservation, so unguarded old writers fail closed.
ALTER TABLE fb_recycle_receipts ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'user' CHECK(actor_type IN ('user','agent'));
ALTER TABLE fb_recycle_receipts ADD COLUMN actor_id TEXT;

CREATE TABLE fb_recycle_requests (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  instance_id TEXT NOT NULL, expected_credit INTEGER NOT NULL CHECK(expected_credit>=0),
  status TEXT NOT NULL CHECK(status IN ('pending','cancelled','completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,idempotency_key)
);
CREATE TRIGGER recycle_request_guard BEFORE INSERT ON fb_recycle_receipts
WHEN NOT EXISTS (SELECT 1 FROM fb_recycle_requests r WHERE r.tenant_id=NEW.tenant_id AND r.user_id=NEW.user_id
  AND r.idempotency_key=NEW.idempotency_key AND r.instance_id=NEW.instance_id AND r.expected_credit=NEW.credit_amount AND r.status='pending')
BEGIN SELECT RAISE(ABORT,'recycle_request_unavailable'); END;
CREATE TRIGGER recycle_request_transition BEFORE UPDATE ON fb_recycle_requests
WHEN OLD.status<>'pending' OR NEW.status NOT IN ('cancelled','completed') OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.user_id IS NOT OLD.user_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.instance_id IS NOT OLD.instance_id
  OR NEW.expected_credit IS NOT OLD.expected_credit OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'recycle_request_immutable'); END;

DROP TRIGGER recycle_apply;
CREATE TRIGGER recycle_apply AFTER INSERT ON fb_recycle_receipts
BEGIN
  UPDATE fb_card_instances SET status='surrendered', updated_at=NEW.created_at
    WHERE id=NEW.instance_id AND tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND status='owned';
  INSERT INTO fb_instance_history
    (id,tenant_id,instance_id,event,from_user_id,to_user_id,reference_type,reference_id,metadata_json,created_at)
  VALUES ('ih_' || NEW.id,NEW.tenant_id,NEW.instance_id,'recycled',NEW.user_id,NULL,'recycle',NEW.id,
    json_object('credit',NEW.credit_amount,'actor_type',NEW.actor_type,'actor_id',COALESCE(NEW.actor_id,NEW.user_id)),NEW.created_at);
  UPDATE fb_wallets SET balance=balance+NEW.credit_amount,updated_at=NEW.created_at
    WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id,tenant_id,user_id,kind,amount,balance_after,reference_type,reference_id,description,idempotency_key,metadata_json,actor_type,actor_id,created_at)
  VALUES ('led_' || NEW.id,NEW.tenant_id,NEW.user_id,'recycle',NEW.credit_amount,
    (SELECT balance FROM fb_wallets WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id),
    'recycle',NEW.id,'Recycled duplicate',NEW.idempotency_key,json_object('instance_id',NEW.instance_id),NEW.actor_type,COALESCE(NEW.actor_id,NEW.user_id),NEW.created_at);
  UPDATE fb_recycle_requests SET status='completed',updated_at=NEW.created_at
    WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id AND idempotency_key=NEW.idempotency_key AND status='pending';
END;
