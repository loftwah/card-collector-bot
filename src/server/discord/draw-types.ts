/**
 * The settled result returned by the shared draw service.
 *
 * This is a type-only contract so the Effect workflow can describe the commit
 * result without importing the Discord command surface (and its Worker-only
 * dependencies) into the pure workflow module.
 */
export interface DrawReceipt {
  draw_id: string;
  instance_id: string;
  card_id: string;
  variant_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  serial: string;
  pool_name: string;
  price: number;
  currency: { name: string; symbol: string };
  balance_after?: number;
  balance_after_debit?: number;
  current_balance?: number;
  credits_total?: number;
  achievement_credits?: Array<{ id: string; name: string; amount: number }>;
  settlement_status?: "settled" | "pending";
  settlement_pending?: boolean;
  probability_bps: number;
  drawn_at: string;
  replayed: boolean;
}
