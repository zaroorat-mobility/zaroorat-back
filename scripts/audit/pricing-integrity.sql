-- Phase 0 Step 0.4 — Read-Only Pricing & Financial Integrity Audit
-- SAFE: Forces read-only transaction mode before executing any query.
SET default_transaction_read_only = on;

SELECT '1_pricing_rules_null_fields' AS check_name,
       COUNT(*) FILTER (WHERE is_active) AS active_rules,
       COUNT(*) FILTER (WHERE is_active AND commission_rate_pct IS NULL) AS active_null_commission,
       COUNT(*) FILTER (WHERE is_active AND tax_rate_pct IS NULL) AS active_null_tax,
       COUNT(*) FILTER (WHERE is_active AND platform_fee_flat IS NULL) AS active_null_platform_fee,
       COUNT(*) FILTER (WHERE is_active AND COALESCE(platform_fee_flat, 0) > 0) AS active_nonzero_platform_fee,
       COUNT(*) FILTER (WHERE is_active AND booking_fee > 0) AS active_nonzero_booking_fee
FROM pricing_rules;

SELECT '2_pricing_rules_active_overlaps' AS check_name,
       COUNT(*) AS overlap_pairs
FROM pricing_rules a
JOIN pricing_rules b
  ON a.id < b.id
 AND a.vehicle_type_id = b.vehicle_type_id
 AND a.city_code = b.city_code
 AND a.service_type IS NOT DISTINCT FROM b.service_type
 AND a.service_zone_id IS NOT DISTINCT FROM b.service_zone_id
 AND tsrange(a.effective_from, a.effective_to) && tsrange(b.effective_from, b.effective_to)
WHERE a.is_active AND b.is_active;

SELECT '3_vehicle_types_without_active_rule' AS check_name,
       vt.code,
       vt.name,
       vt.is_active
FROM vehicle_types vt
LEFT JOIN pricing_rules pr
  ON pr.vehicle_type_id = vt.id
 AND pr.is_active = true
 AND pr.effective_from <= now()
 AND (pr.effective_to IS NULL OR pr.effective_to > now())
WHERE vt.is_active = true
  AND pr.id IS NULL;

SELECT '4_cab_alias_audited_moves' AS check_name,
       COUNT(*) AS possible_cab_alias_moves
FROM admin_activity_logs
WHERE entity_type IN ('fare_rule', 'pricing_rule')
  AND metadata::text ILIKE '%CAB_%';

SELECT '5_frozen_ride_receipts_null_fare' AS check_name,
       COUNT(*) AS total_receipts,
       COUNT(*) FILTER (WHERE snapshot_json->'fare' IS NULL OR snapshot_json->>'fare' = 'null') AS null_fare_receipts
FROM ride_receipts;

SELECT '6_driver_payable_and_platform_fee_ledger' AS check_name,
       account,
       COUNT(*) AS entry_count,
       COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debit,
       COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credit
FROM payment_ledger_entries
WHERE account IN ('DRIVER_PAYABLE', 'PLATFORM_FEE', 'TAX_PAYABLE', 'PLATFORM_COMMISSION', 'DRIVER_COMMISSION_WALLET')
GROUP BY account
ORDER BY account;

SELECT '7_admin_credit_wallet_txns_summary' AS check_name,
       txn_type,
       COUNT(*) AS txn_count,
       COALESCE(SUM(amount), 0) AS sum_amount
FROM driver_commission_wallet_transactions
GROUP BY txn_type
ORDER BY txn_type;

SELECT '8_completed_commission_rides_missing_debit' AS check_name,
       COUNT(*) AS completed_commission_rides,
       COUNT(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1
           FROM driver_commission_wallet_transactions t
           WHERE t.ride_id = r.id
             AND t.txn_type = 'RIDE_COMMISSION'
         )
       ) AS missing_commission_debit_count
FROM rides r
WHERE r.status = 'COMPLETED'
  AND r.driver_payment_model = 'COMMISSION';

SELECT '9_negative_commission_wallets' AS check_name,
       COUNT(*) AS negative_wallet_count
FROM driver_commission_wallets
WHERE balance < 0;

SELECT '10_billing_invoices_and_templates' AS check_name,
       (SELECT COUNT(*) FROM billing_invoices) AS billing_invoice_rows,
       (SELECT COUNT(*) FROM invoice_templates) AS invoice_template_rows;
