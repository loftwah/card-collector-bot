-- The shared reward-claim trigger credits the wallet atomically. Keep that
-- guarantee, but describe daily missions truthfully instead of reusing the
-- daily-allowance label for every reward claim.
DROP TRIGGER IF EXISTS rewards_apply_credit;
CREATE TRIGGER rewards_apply_credit
AFTER INSERT ON fb_reward_claims
BEGIN
  UPDATE fb_wallets SET balance = balance + NEW.amount, updated_at = NEW.created_at
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id;
  INSERT INTO fb_ledger_entries
    (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
     description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
  VALUES
    ('led_' || NEW.id, NEW.tenant_id, NEW.user_id, 'issue', NEW.amount,
     (SELECT balance FROM fb_wallets WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id),
     'reward', NEW.id,
     CASE WHEN NEW.rule_key LIKE 'mission:%' THEN 'Daily mission reward' ELSE 'Daily cabinet allowance' END,
     NEW.idempotency_key,
     json_object('rule_key', NEW.rule_key, 'rule_version', NEW.rule_version, 'period_key', NEW.period_key),
     'user', NEW.user_id, NEW.created_at);
END;
