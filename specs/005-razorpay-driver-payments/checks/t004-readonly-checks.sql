-- 005-razorpay-driver-payments T004 / D-9: read-only pre-migration checks Q1–Q11
-- (data-model.md §12), plus M1–M4 migration-readiness facts.
--
-- SAFETY
-- * Runs inside a READ ONLY transaction and ends with ROLLBACK: it cannot write.
-- * Prints counts and categories only: no ids, names, phone numbers, emails,
--   amounts per person, payloads or settings values other than a provider name.
-- * statement_timeout bounds each query. On a large production database run it at a
--   quiet time; every query is a sequential aggregate at worst.
--
-- USAGE (operator): psql "<the environment's own read-only URL>" -v ON_ERROR_STOP=1 -f t004-readonly-checks.sql
-- Q10 must run through the API's own DATABASE_URL (the role the application uses).

BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
-- Never queue behind (or hold up) a lock on a busy database.
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

\echo '--- TARGET (confirm before reading results; STOP if any value is unexpected) ---'
SELECT current_database() AS database, current_user AS role, session_user AS login,
       inet_server_addr() AS server_addr, inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       pg_is_in_recovery() AS is_read_replica,
       current_setting('transaction_read_only') AS transaction_read_only,
       (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations_applied,
       (SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL) AS latest_migration,
       now() AS checked_at;

\echo '--- Q1 duplicate (gateway, gateway_intent_id) -> blocks payment_intents_gateway_intent_key ---'
SELECT count(*) AS duplicate_groups, coalesce(sum(n), 0) AS rows_involved
FROM (SELECT gateway, gateway_intent_id, count(*) AS n
      FROM payment_intents WHERE gateway_intent_id IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) > 1) d;

\echo '--- Q2 SUCCEEDED recharge intents with no MANUAL_RECHARGE row (paid, not credited) ---'
SELECT count(*) AS paid_not_credited
FROM payment_intents pi
WHERE pi.purpose = 'DRIVER_COMMISSION_RECHARGE' AND pi.status = 'SUCCEEDED'
  AND NOT EXISTS (SELECT 1 FROM driver_commission_wallet_transactions t
                  WHERE t.txn_type = 'MANUAL_RECHARGE' AND t.reference_id = pi.id);

\echo '--- Q3 duplicate MANUAL_RECHARGE per reference_id -> blocks commission_wallet_one_credit_per_intent ---'
SELECT count(*) AS duplicate_groups
FROM (SELECT reference_id FROM driver_commission_wallet_transactions
      WHERE txn_type = 'MANUAL_RECHARGE' GROUP BY 1 HAVING count(*) > 1) d;

\echo '--- Q4a duplicate SUCCEEDED PAYMENT (gateway, gateway_txn_id) -> blocks payment_transactions_provider_payment_key ---'
SELECT count(*) AS duplicate_groups
FROM (SELECT gateway, gateway_txn_id FROM payment_transactions
      WHERE txn_type = 'PAYMENT' AND status = 'SUCCEEDED' AND gateway_txn_id IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) > 1) d;

\echo '--- Q4b SUCCEEDED PAYMENT rows by gateway and id kind (UD-8: non-pay_ ids, order ids stored as payment ids) ---'
SELECT coalesce(pt.gateway, '(null)') AS gateway,
       CASE WHEN pt.gateway_txn_id IS NULL THEN 'null'
            WHEN pt.gateway_txn_id LIKE 'pay\_%' THEN 'pay_'
            WHEN pt.gateway_txn_id LIKE 'order\_%' THEN 'order_'
            WHEN pt.gateway_txn_id LIKE 'mock\_%' THEN 'mock_'
            WHEN pt.gateway_txn_id LIKE 'pi\_%' OR pt.gateway_txn_id LIKE 'ch\_%' THEN 'stripe'
            ELSE 'other' END AS id_kind,
       count(*) AS rows,
       count(*) FILTER (WHERE pt.gateway_txn_id = pi.gateway_intent_id) AS equals_own_order_id
FROM payment_transactions pt
JOIN payment_intents pi ON pi.id = pt.intent_id
WHERE pt.txn_type = 'PAYMENT' AND pt.status = 'SUCCEEDED'
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '--- Q5 negative commission-wallet balances -> blocks the D-2 CHECK (T020b) ---'
SELECT count(*) AS negative_wallets FROM driver_commission_wallets WHERE balance < 0;

\echo '--- Q6 subscription/payment disagreements ---'
SELECT
  (SELECT count(*) FROM driver_subscriptions s
     JOIN payment_intents pi ON pi.id = s.payment_intent_id
    WHERE s.status = 'PENDING_PAYMENT' AND pi.status = 'SUCCEEDED') AS pending_sub_with_succeeded_intent,
  (SELECT count(*) FROM payment_intents pi
    WHERE pi.purpose = 'DRIVER_SUBSCRIPTION_PAYMENT' AND pi.status = 'SUCCEEDED'
      AND NOT EXISTS (SELECT 1 FROM driver_subscriptions s WHERE s.payment_intent_id = pi.id))
    AS succeeded_sub_intent_without_subscription;

\echo '--- Q7 FAILED (dead-lettered) outbox events by type ---'
SELECT event_type, count(*) AS failed FROM outbox_events
WHERE status::text = 'FAILED' GROUP BY 1 ORDER BY 2 DESC, 1;

\echo '--- Q8 unbalanced ledger groups ---'
SELECT count(*) AS unbalanced_groups
FROM (SELECT entry_group FROM payment_ledger_entries GROUP BY 1
      HAVING sum(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0) u;

\echo '--- Q9 intents with more than one SUCCEEDED PAYMENT row -> blocks payment_transactions_one_success_per_intent ---'
SELECT count(*) AS intents
FROM (SELECT intent_id FROM payment_transactions
      WHERE txn_type = 'PAYMENT' AND status = 'SUCCEEDED' GROUP BY 1 HAVING count(*) > 1) d;

\echo '--- Q10 role this connection uses (meaningful only through the API DATABASE_URL) ---'
SELECT current_user AS role,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime') AS runtime_role_exists,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime')
            THEN pg_has_role(current_user, 'zaroorat_app_runtime', 'member') END AS member_of_runtime_role;

\echo '--- Q10b role attributes and actual permissions on the financial tables ---'
SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
       r.rolcreaterole AS create_role, r.rolinherit AS inherits
FROM pg_roles r WHERE r.rolname = current_user;
SELECT t.tablename,
       t.tableowner = current_user AS role_is_owner,
       pg_has_role(current_user, t.tableowner, 'USAGE') AS role_inherits_owner,
       has_table_privilege(current_user, quote_ident(t.tablename), 'INSERT') AS can_insert,
       has_table_privilege(current_user, quote_ident(t.tablename), 'UPDATE') AS can_update,
       has_table_privilege(current_user, quote_ident(t.tablename), 'DELETE') AS can_delete,
       has_table_privilege(current_user, quote_ident(t.tablename), 'TRUNCATE') AS can_truncate
FROM pg_tables t
WHERE t.schemaname = 'public'
  AND t.tablename IN ('payment_intents', 'payment_transactions', 'payment_ledger_entries',
                      'driver_commission_wallet_transactions', 'driver_commission_wallets',
                      'gateway_events', 'refunds', 'admin_activity_logs', 'audit_field_changes')
ORDER BY 1;

\echo '--- Q2b/Q6c seed fixtures vs. genuine rows (development seed writes gi_seed_ orders and seed- keys) ---'
SELECT 'Q2 paid recharge without MANUAL_RECHARGE' AS finding,
       count(*) FILTER (WHERE pi.gateway_intent_id LIKE 'gi\_seed\_%' OR pi.idempotency_key LIKE 'seed-%') AS seed_fixture_rows,
       count(*) FILTER (WHERE NOT (coalesce(pi.gateway_intent_id, '') LIKE 'gi\_seed\_%' OR pi.idempotency_key LIKE 'seed-%')) AS genuine_rows
FROM payment_intents pi
WHERE pi.purpose = 'DRIVER_COMMISSION_RECHARGE' AND pi.status = 'SUCCEEDED'
  AND NOT EXISTS (SELECT 1 FROM driver_commission_wallet_transactions t
                  WHERE t.txn_type = 'MANUAL_RECHARGE' AND t.reference_id = pi.id)
UNION ALL
SELECT 'Q6b succeeded subscription intent without subscription',
       count(*) FILTER (WHERE pi.gateway_intent_id LIKE 'gi\_seed\_%' OR pi.idempotency_key LIKE 'seed-%'),
       count(*) FILTER (WHERE NOT (coalesce(pi.gateway_intent_id, '') LIKE 'gi\_seed\_%' OR pi.idempotency_key LIKE 'seed-%'))
FROM payment_intents pi
WHERE pi.purpose = 'DRIVER_SUBSCRIPTION_PAYMENT' AND pi.status = 'SUCCEEDED'
  AND NOT EXISTS (SELECT 1 FROM driver_subscriptions s WHERE s.payment_intent_id = pi.id);

\echo '--- Q4c UD-8 indicator: Razorpay SUCCEEDED rows whose payment id is not a pay_ id ---'
SELECT count(*) FILTER (WHERE pt.gateway_txn_id IS NULL OR pt.gateway_txn_id NOT LIKE 'pay\_%') AS razorpay_rows_without_pay_id,
       count(*) FILTER (WHERE pt.gateway_txn_id = pi.gateway_intent_id) AS razorpay_rows_storing_order_id,
       (count(*) FILTER (WHERE pt.gateway_txn_id IS NULL OR pt.gateway_txn_id NOT LIKE 'pay\_%') > 0) AS ud8_work_indicated
FROM payment_transactions pt
JOIN payment_intents pi ON pi.id = pt.intent_id
WHERE pt.txn_type = 'PAYMENT' AND pt.status = 'SUCCEEDED' AND pt.gateway = 'razorpay'
  AND NOT (coalesce(pi.gateway_intent_id, '') LIKE 'gi\_seed\_%');

\echo '--- Q11a open intents by gateway, purpose, status and age ---'
SELECT coalesce(gateway, '(null)') AS gateway, purpose, status,
       CASE WHEN created_at > now() - interval '1 day' THEN '<1d'
            WHEN created_at > now() - interval '5 days' THEN '1-5d'
            ELSE '>5d' END AS age,
       count(*) AS intents
FROM payment_intents WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;

\echo '--- Q11b configured active provider (null = env default) ---'
SELECT count(*) AS rows,
       max(CASE WHEN value::text ~ '^"?(mock|razorpay|stripe)"?$' THEN value::text ELSE '<not a provider name>' END)
         AS active_provider_setting
FROM system_settings WHERE category = 'integrations.payment' AND key = 'payment.active_provider';

\echo '--- Q11c UD-11 trigger: open historical CUSTOMER_WALLET_TOPUP intents with a razorpay order ---'
SELECT count(*) AS open_customer_topups_on_razorpay FROM payment_intents
WHERE purpose = 'CUSTOMER_WALLET_TOPUP' AND gateway = 'razorpay'
  AND status IN ('PENDING', 'PROCESSING', 'FAILED');

\echo '--- M1 table sizes (lock and CONCURRENTLY planning): exact counts, not pg_stat estimates ---'
SELECT 'payment_intents' AS table_name, count(*) AS exact_rows, pg_size_pretty(pg_total_relation_size('payment_intents')) AS total_size FROM payment_intents
UNION ALL SELECT 'payment_transactions', count(*), pg_size_pretty(pg_total_relation_size('payment_transactions')) FROM payment_transactions
UNION ALL SELECT 'driver_commission_wallet_transactions', count(*), pg_size_pretty(pg_total_relation_size('driver_commission_wallet_transactions')) FROM driver_commission_wallet_transactions
UNION ALL SELECT 'payment_ledger_entries', count(*), pg_size_pretty(pg_total_relation_size('payment_ledger_entries')) FROM payment_ledger_entries
UNION ALL SELECT 'gateway_events', count(*), pg_size_pretty(pg_total_relation_size('gateway_events')) FROM gateway_events
UNION ALL SELECT 'refunds', count(*), pg_size_pretty(pg_total_relation_size('refunds')) FROM refunds;

\echo '--- M1b long-running transactions right now (a migration would queue behind them) ---'
SELECT count(*) FILTER (WHERE xact_start < now() - interval '1 minute') AS xacts_over_1_min,
       count(*) FILTER (WHERE xact_start < now() - interval '10 minutes') AS xacts_over_10_min
FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();

\echo '--- M2 name collisions with objects T020 creates (expect 0) ---'
SELECT
  (SELECT count(*) FROM pg_tables WHERE tablename IN ('payment_review_cases', 'payment_reconciliation_runs')) AS tables,
  (SELECT count(*) FROM pg_indexes WHERE indexname IN ('payment_intents_gateway_intent_key',
     'payment_transactions_provider_payment_key', 'payment_transactions_one_success_per_intent',
     'commission_wallet_one_credit_per_intent')) AS indexes,
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('payment_ledger_entries_append_only',
     'payment_ledger_entries_no_truncate', 'driver_commission_wallet_transactions_append_only',
     'driver_commission_wallet_transactions_no_truncate')) AS triggers;

\echo '--- M3 prerequisites T020 relies on (expect reject_audit_mutation = 1) ---'
SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'reject_audit_mutation') AS reject_audit_mutation,
       (SELECT count(*) FROM pg_proc WHERE proname = 'reject_financial_truncate') AS reject_financial_truncate_already;

\echo '--- M4 statuses the new code writes, already present? (expect 0) ---'
SELECT
  (SELECT count(*) FROM payment_intents WHERE status IN ('MANUAL_REVIEW', 'EXPIRED')) AS new_intent_statuses,
  (SELECT count(*) FROM payment_transactions WHERE status = 'CAPTURED_REVIEW') AS captured_review_rows;

ROLLBACK;
