-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'REGISTER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('UNVERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RideRequestStatus" AS ENUM ('CREATED', 'SEARCHING', 'MATCHED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DispatchResponse" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'TIMEOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DriverDocumentType" AS ENUM ('DRIVING_LICENSE', 'RC', 'INSURANCE', 'AADHAAR', 'PAN', 'PUC', 'POLICE_VERIFICATION', 'PROFILE_PHOTO');

-- CreateEnum
CREATE TYPE "DriverWalletTxnType" AS ENUM ('RIDE_EARNING', 'BONUS', 'INCENTIVE', 'PENALTY', 'WITHDRAWAL', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "DriverVerificationStatus" AS ENUM ('PENDING', 'DOCUMENT_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('ONLINE', 'OFFLINE', 'BUSY', 'ON_TRIP', 'BREAK');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'WALLET', 'CARD', 'UPI');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('REQUESTED', 'SEARCHING', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER', 'CANCELLED_BY_SYSTEM', 'NO_DRIVERS_FOUND');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'SMS', 'EMAIL', 'IN_APP', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL', 'SAFETY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ChatConversationType" AS ENUM ('RIDE', 'SUPPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ChatConversationStatus" AS ENUM ('ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ChatParticipantRole" AS ENUM ('CUSTOMER', 'DRIVER', 'SUPPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ChatMessageType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'LOCATION', 'SYSTEM', 'CANNED');

-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'DELETED');

-- CreateEnum
CREATE TYPE "RatingTargetType" AS ENUM ('DRIVER', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "RatingSentiment" AS ENUM ('POSITIVE', 'NEGATIVE', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "ReviewFlagStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketChannel" AS ENUM ('APP', 'EMAIL', 'PHONE', 'CHAT', 'SOCIAL');

-- CreateEnum
CREATE TYPE "TicketMessageAuthor" AS ENUM ('CUSTOMER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'SIGNED_UP', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('PENDING', 'CREDITED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReferralRewardBeneficiary" AS ENUM ('REFERRER', 'REFEREE');

-- CreateEnum
CREATE TYPE "ReferralFraudStatus" AS ENUM ('CLEAN', 'SUSPECTED', 'CONFIRMED', 'CLEARED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignObjective" AS ENUM ('ACQUISITION', 'RETENTION', 'REACTIVATION', 'AWARENESS');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'ASSIGNED', 'REDEEMED', 'EXPIRED', 'VOID');

-- CreateEnum
CREATE TYPE "BannerPlacement" AS ENUM ('HOME', 'RIDE', 'WALLET', 'SPLASH', 'OFFERS');

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "SettingType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "FeatureFlagStatus" AS ENUM ('ON', 'OFF', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AnalyticsActorType" AS ENUM ('CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM', 'ANONYMOUS');

-- CreateEnum
CREATE TYPE "MetricGranularity" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'XLSX', 'PDF', 'JSON');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "AppPlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "DeviceTrustState" AS ENUM ('REGISTERED', 'TRUSTED', 'SUSPICIOUS', 'REVOKED');

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "effect" "PermissionEffect" NOT NULL DEFAULT 'ALLOW',

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_activity_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" "AuditAction" NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "summary" TEXT,
    "ip_address" INET,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_field_changes" (
    "id" UUID NOT NULL,
    "activity_log_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,

    CONSTRAINT "audit_field_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "value_type" "SettingType" NOT NULL DEFAULT 'STRING',
    "category" TEXT,
    "description" TEXT,
    "is_secret" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "status" "FeatureFlagStatus" NOT NULL DEFAULT 'OFF',
    "rollout_percentage" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag_overrides" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "user_id" UUID,
    "segment_code" TEXT,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ip_address" INET,
    "user_agent" TEXT,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT,
    "scopes" JSONB,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_allowlist" (
    "id" UUID NOT NULL,
    "cidr" INET NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_allowlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "center" geography(Point,4326),
    "boundary" geography(Polygon,4326),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "launched_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_zones" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone_type" TEXT NOT NULL DEFAULT 'SERVICE',
    "boundary" geography(Polygon,4326) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_versions" (
    "id" UUID NOT NULL,
    "platform" "AppPlatform" NOT NULL,
    "version" TEXT NOT NULL,
    "build_number" INTEGER,
    "is_supported" BOOLEAN NOT NULL DEFAULT true,
    "force_update" BOOLEAN NOT NULL DEFAULT false,
    "changelog" TEXT,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_queue" (
    "id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "payload" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "payload" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "event_types" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_code" INTEGER,
    "response_body" TEXT,
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "request_hash" TEXT,
    "response" JSONB,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "locked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "limit_count" INTEGER NOT NULL,
    "window_seconds" INTEGER NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'BLOCK',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_windows" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "affected_services" TEXT[],
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_policies" (
    "id" UUID NOT NULL,
    "table_name" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'DELETE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "schema" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_metrics" (
    "id" UUID NOT NULL,
    "metric_date" DATE NOT NULL,
    "metric_key" TEXT NOT NULL,
    "city_code" TEXT,
    "granularity" "MetricGranularity" NOT NULL DEFAULT 'DAILY',
    "value" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnels" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funnel_steps" (
    "id" UUID NOT NULL,
    "funnel_id" UUID NOT NULL,
    "step_order" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "event_type_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohorts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB,
    "cohort_date" DATE NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cohort_retention" (
    "id" UUID NOT NULL,
    "cohort_id" UUID NOT NULL,
    "period_number" SMALLINT NOT NULL,
    "retained_count" INTEGER NOT NULL DEFAULT 0,
    "retention_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cohort_retention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_snapshots" (
    "id" UUID NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "granularity" "MetricGranularity" NOT NULL DEFAULT 'DAILY',
    "city_code" TEXT,
    "kpis" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL,
    "dashboard_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "widget_type" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "position" SMALLINT DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "report_type" TEXT NOT NULL,
    "params" JSONB,
    "format" "ReportFormat" NOT NULL DEFAULT 'CSV',
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "file_url" TEXT,
    "row_count" INTEGER,
    "requested_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "ip_address" INET,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "rotated_from" UUID,
    "rotated_to" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "phone_number" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip_address" INET,
    "device_id" UUID,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "driver_code" TEXT NOT NULL,
    "verification_status" "DriverVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "current_vehicle_id" UUID,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    "total_rides" INTEGER NOT NULL DEFAULT 0,
    "total_distance_km" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_earnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "is_available" BOOLEAN NOT NULL DEFAULT false,
    "is_suspended" BOOLEAN NOT NULL DEFAULT false,
    "approved_at" TIMESTAMP(3),
    "approved_by" UUID,
    "rejection_reason" TEXT,
    "last_ride_at" TIMESTAMP(3),
    "acceptance_rate" DECIMAL(5,2),
    "completion_rate" DECIMAL(5,2),
    "cancellation_rate" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "full_legal_name" TEXT,
    "date_of_birth" DATE,
    "gender" TEXT,
    "address_line" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT DEFAULT 'India',
    "postal_code" TEXT,
    "preferred_language" TEXT DEFAULT 'en',
    "blood_group" TEXT,
    "profile_photo" TEXT,
    "alternate_phone" TEXT,
    "driving_experience_years" SMALLINT,
    "spoken_languages" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_documents" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "document_type" "DriverDocumentType" NOT NULL,
    "document_number" TEXT,
    "file_url" TEXT NOT NULL,
    "issued_at" DATE,
    "expires_at" DATE,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_by" UUID,
    "verified_at" TIMESTAMP(3),
    "verification_notes" TEXT,
    "ocr_data" JSONB,
    "document_checksum" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_bank_accounts" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "account_holder_name" TEXT,
    "bank_name" TEXT,
    "ifsc_code" TEXT,
    "account_number_enc" TEXT,
    "upi_id" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "verified_by" UUID,
    "payout_enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider_fund_account_id" TEXT,
    "beneficiary_id" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_wallets" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "locked_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "last_transaction_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_wallet_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "txn_type" "DriverWalletTxnType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_online_status" (
    "driver_id" UUID NOT NULL,
    "status" "DriverStatus" NOT NULL DEFAULT 'OFFLINE',
    "last_online_at" TIMESTAMP(3),
    "last_offline_at" TIMESTAMP(3),
    "current_shift_id" UUID,
    "heartbeat_at" TIMESTAMP(3),
    "battery_level" SMALLINT,
    "network_type" TEXT,
    "app_version" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_online_status_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "driver_locations" (
    "driver_id" UUID NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "location" geography(Point,4326) NOT NULL,
    "heading" DECIMAL(5,2),
    "bearing" DECIMAL(5,2),
    "speed_kmh" DECIMAL(6,2),
    "accuracy_meters" DECIMAL(6,2),
    "altitude" DECIMAL(8,2),
    "provider" TEXT,
    "gps_source" TEXT,
    "is_mock_location" BOOLEAN NOT NULL DEFAULT false,
    "ride_id" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_locations_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "driver_shift_logs" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "shift_start" TIMESTAMP(3) NOT NULL,
    "shift_end" TIMESTAMP(3),
    "total_online_minutes" INTEGER NOT NULL DEFAULT 0,
    "total_trip_minutes" INTEGER NOT NULL DEFAULT 0,
    "idle_minutes" INTEGER NOT NULL DEFAULT 0,
    "completed_rides" INTEGER NOT NULL DEFAULT 0,
    "accepted_trips" INTEGER NOT NULL DEFAULT 0,
    "rejected_trips" INTEGER NOT NULL DEFAULT 0,
    "cancelled_trips" INTEGER NOT NULL DEFAULT 0,
    "distance_driven_km" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "earnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_shift_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "category" "NotificationCategory" NOT NULL DEFAULT 'TRANSACTIONAL',
    "title_template" TEXT,
    "body_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL DEFAULT 'TRANSACTIONAL',
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "event_key" TEXT,
    "template_id" UUID,
    "title" TEXT,
    "body" TEXT,
    "data" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "reference_type" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "provider_message_id" TEXT,
    "target" TEXT,
    "device_id" UUID,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_app_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_id" UUID,
    "title" TEXT,
    "body" TEXT,
    "icon" TEXT,
    "deep_link" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "in_app_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL DEFAULT 'PROMOTIONAL',
    "channel" "NotificationChannel" NOT NULL,
    "template_id" UUID,
    "segment" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMP(3),
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_id" UUID,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_provider_logs" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_type" TEXT,
    "provider_message_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_provider_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method_type" TEXT NOT NULL,
    "gateway" TEXT,
    "gateway_token" TEXT,
    "brand" TEXT,
    "last4" CHAR(4),
    "upi_vpa" TEXT,
    "expiry_month" SMALLINT,
    "expiry_year" SMALLINT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_wallets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "locked_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "last_transaction_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_wallet_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "txn_type" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance_after" DECIMAL(12,2) NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "ride_id" UUID,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method_type" TEXT NOT NULL,
    "payment_method_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "gateway" TEXT,
    "gateway_intent_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "ride_id" UUID,
    "user_id" UUID NOT NULL,
    "txn_type" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "gateway" TEXT,
    "gateway_txn_id" TEXT,
    "gateway_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_events" (
    "id" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "gateway_event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "ride_id" UUID,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gateway_refund_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_ledger_entries" (
    "id" UUID NOT NULL,
    "entry_group" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "account_ref_id" UUID,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reference_type" TEXT,
    "reference_id" UUID,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_settlements" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "gross_earnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adjustments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_payable" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_payouts" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "settlement_id" UUID,
    "bank_account_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "gateway" TEXT,
    "gateway_payout_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "failure_reason" TEXT,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "driver_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_items" (
    "id" UUID NOT NULL,
    "payout_id" UUID NOT NULL,
    "ride_id" UUID,
    "item_type" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chargebacks" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "ride_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "gateway_case_id" TEXT,
    "evidence_due_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chargebacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "vehicle_type_id" UUID NOT NULL,
    "city_code" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "base_fare" DECIMAL(10,2) NOT NULL,
    "minimum_fare" DECIMAL(10,2) NOT NULL,
    "per_km_rate" DECIMAL(10,2) NOT NULL,
    "per_minute_rate" DECIMAL(10,2) NOT NULL,
    "free_waiting_min" SMALLINT NOT NULL DEFAULT 3,
    "waiting_per_min" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "included_km" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "booking_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "platform_fee_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "night_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surge_zones" (
    "id" UUID NOT NULL,
    "city_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "boundary" geography(Polygon,4326) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surge_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surge_windows" (
    "id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "vehicle_type_id" UUID,
    "multiplier" DECIMAL(4,2) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DYNAMIC',
    "reason" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surge_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "toll_zones" (
    "id" UUID NOT NULL,
    "city_code" TEXT,
    "name" TEXT NOT NULL,
    "boundary" geography(Polygon,4326),
    "charge" DECIMAL(10,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "toll_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" UUID NOT NULL,
    "vehicle_type_id" UUID,
    "city_code" TEXT,
    "cancelled_by" TEXT NOT NULL,
    "free_cancel_window_sec" INTEGER NOT NULL DEFAULT 120,
    "min_status" TEXT,
    "fee_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fee_type" TEXT NOT NULL DEFAULT 'FLAT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "discount_type" TEXT NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "max_discount" DECIMAL(10,2),
    "min_fare" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "applicable_city" TEXT,
    "applicable_vehicle_type" UUID,
    "first_ride_only" BOOLEAN NOT NULL DEFAULT false,
    "usage_limit_total" INTEGER,
    "usage_limit_per_user" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ride_id" UUID,
    "discount_amount" DECIMAL(10,2) NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_configs" (
    "id" UUID NOT NULL,
    "city_code" TEXT,
    "tax_name" TEXT NOT NULL,
    "rate_pct" DECIMAL(5,2) NOT NULL,
    "applies_to" TEXT NOT NULL DEFAULT 'SUBTOTAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_campaigns" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" "CampaignObjective" NOT NULL DEFAULT 'ACQUISITION',
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "budget" DECIMAL(14,2),
    "spent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promo_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_segments" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB,
    "estimated_size" INTEGER,
    "is_dynamic" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audience_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_targets" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "promotion_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_batches" (
    "id" UUID NOT NULL,
    "campaign_id" UUID,
    "promotion_id" UUID NOT NULL,
    "name" TEXT,
    "prefix" TEXT,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "generated_count" INTEGER NOT NULL DEFAULT 0,
    "per_user_limit" SMALLINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "user_id" UUID,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "redeemed_ride_id" UUID,
    "assigned_at" TIMESTAMP(3),
    "redeemed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_banners" (
    "id" UUID NOT NULL,
    "campaign_id" UUID,
    "title" TEXT,
    "image_url" TEXT NOT NULL,
    "placement" "BannerPlacement" NOT NULL DEFAULT 'HOME',
    "action_url" TEXT,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_programs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "referrer_reward" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "referee_reward" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reward_type" TEXT NOT NULL DEFAULT 'WALLET',
    "qualifying_event" TEXT NOT NULL DEFAULT 'FIRST_RIDE',
    "qualifying_threshold" SMALLINT NOT NULL DEFAULT 1,
    "max_referrals_per_user" INTEGER,
    "reward_expiry_days" INTEGER,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "uses_count" INTEGER NOT NULL DEFAULT 0,
    "max_uses" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "referrer_id" UUID NOT NULL,
    "referee_id" UUID,
    "referral_code_id" UUID,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifying_rides" INTEGER NOT NULL DEFAULT 0,
    "signed_up_at" TIMESTAMP(3),
    "qualified_at" TIMESTAMP(3),
    "rewarded_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "beneficiary" "ReferralRewardBeneficiary" NOT NULL,
    "user_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reward_type" TEXT NOT NULL DEFAULT 'WALLET',
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'PENDING',
    "wallet_transaction_id" UUID,
    "credited_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_milestones" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "required_referrals" INTEGER NOT NULL,
    "bonus_amount" DECIMAL(10,2) NOT NULL,
    "reward_type" TEXT NOT NULL DEFAULT 'WALLET',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_fraud_flags" (
    "id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReferralFraudStatus" NOT NULL DEFAULT 'SUSPECTED',
    "details" JSONB,
    "reviewed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "referral_fraud_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_requests" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_type_id" UUID NOT NULL,
    "pickup_lat" DECIMAL(10,7) NOT NULL,
    "pickup_lng" DECIMAL(10,7) NOT NULL,
    "pickup_location" geography(Point,4326) NOT NULL,
    "pickup_address" TEXT,
    "drop_lat" DECIMAL(10,7),
    "drop_lng" DECIMAL(10,7),
    "drop_location" geography(Point,4326),
    "drop_address" TEXT,
    "estimated_distance_km" DECIMAL(8,2),
    "estimated_duration_min" INTEGER,
    "quoted_fare" DECIMAL(10,2),
    "surge_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "payment_method" TEXT,
    "promo_code" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "status" "RideRequestStatus" NOT NULL DEFAULT 'CREATED',
    "ride_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "ride_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_dispatches" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "response" "DispatchResponse" NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "driver_distance_m" INTEGER,
    "driver_eta_seconds" INTEGER,
    "dispatch_round" SMALLINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "ride_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rides" (
    "id" UUID NOT NULL,
    "ride_code" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "vehicle_type_id" UUID NOT NULL,
    "status" "RideStatus" NOT NULL DEFAULT 'ACCEPTED',
    "payment_method" "PaymentMethod" NOT NULL,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "pickup_location" geography(Point,4326) NOT NULL,
    "pickup_address" TEXT,
    "drop_location" geography(Point,4326),
    "drop_address" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrived_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "actual_distance_km" DECIMAL(8,2),
    "actual_duration_min" INTEGER,
    "wait_time_min" INTEGER NOT NULL DEFAULT 0,
    "is_scheduled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_stops" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "sequence" SMALLINT NOT NULL,
    "stop_type" TEXT NOT NULL,
    "location" geography(Point,4326) NOT NULL,
    "address" TEXT,
    "arrived_at" TIMESTAMP(3),
    "departed_at" TIMESTAMP(3),

    CONSTRAINT "ride_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_status_events" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_type" TEXT,
    "actor_id" UUID,
    "reason" TEXT,
    "location" geography(Point,4326),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_fares" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "base_fare" DECIMAL(10,2) NOT NULL,
    "distance_fare" DECIMAL(10,2) NOT NULL,
    "time_fare" DECIMAL(10,2) NOT NULL,
    "waiting_charge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "surge_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "surge_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "toll_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "platform_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tip_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_fare" DECIMAL(10,2) NOT NULL,
    "driver_earning" DECIMAL(10,2) NOT NULL,
    "platform_commission" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_fares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_fare_lines" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "line_type" TEXT NOT NULL,
    "label" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "sequence" SMALLINT,

    CONSTRAINT "ride_fare_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_cancellations" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "cancelled_by" TEXT NOT NULL,
    "actor_id" UUID,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT,
    "cancelled_at_status" TEXT,
    "cancellation_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fee_charged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_otps" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'START',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_receipts" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "pdf_url" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_payments" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "payment_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_ratings" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "rated_by" TEXT NOT NULL,
    "rating" SMALLINT NOT NULL,
    "tags" TEXT[],
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_promos_applied" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "promo_code" TEXT NOT NULL,
    "promo_id" UUID,
    "discount_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_promos_applied_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_rides" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "reminder_sent_at" TIMESTAMP(3),
    "ride_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_rides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_route_plan" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "encoded_polyline" TEXT,
    "planned_distance_km" DECIMAL(8,2),
    "planned_duration_min" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_route_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_wait_events" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "billed_minutes" INTEGER NOT NULL DEFAULT 0,
    "charge" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ride_wait_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ride_disputes" (
    "id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "raised_by" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "refund_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "ride_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "type" "ChatConversationType" NOT NULL DEFAULT 'RIDE',
    "ride_id" UUID,
    "status" "ChatConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_participants" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ChatParticipantRole" NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMP(3),
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID,
    "message_type" "ChatMessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "status" "ChatMessageStatus" NOT NULL DEFAULT 'SENT',
    "reply_to_id" UUID,
    "metadata" JSONB,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "media_type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "size_bytes" BIGINT,
    "duration_sec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_read_receipts" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),

    CONSTRAINT "chat_read_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_canned_replies" (
    "id" UUID NOT NULL,
    "role" "ChatParticipantRole" NOT NULL,
    "category" TEXT,
    "text" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_blocks" (
    "id" UUID NOT NULL,
    "blocker_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_reports" (
    "id" UUID NOT NULL,
    "conversation_id" UUID,
    "message_id" UUID,
    "reporter_id" UUID NOT NULL,
    "reported_id" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "chat_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_tags" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "target_type" "RatingTargetType" NOT NULL,
    "sentiment" "RatingSentiment" NOT NULL DEFAULT 'POSITIVE',
    "min_stars" SMALLINT DEFAULT 1,
    "max_stars" SMALLINT DEFAULT 5,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_tag_assignments" (
    "id" UUID NOT NULL,
    "ride_rating_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_rating_aggregates" (
    "driver_id" UUID NOT NULL,
    "avg_rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "total_ratings" INTEGER NOT NULL DEFAULT 0,
    "star1" INTEGER NOT NULL DEFAULT 0,
    "star2" INTEGER NOT NULL DEFAULT 0,
    "star3" INTEGER NOT NULL DEFAULT 0,
    "star4" INTEGER NOT NULL DEFAULT 0,
    "star5" INTEGER NOT NULL DEFAULT 0,
    "last_rated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_rating_aggregates_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "customer_rating_aggregates" (
    "user_id" UUID NOT NULL,
    "avg_rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "total_ratings" INTEGER NOT NULL DEFAULT 0,
    "star1" INTEGER NOT NULL DEFAULT 0,
    "star2" INTEGER NOT NULL DEFAULT 0,
    "star3" INTEGER NOT NULL DEFAULT 0,
    "star4" INTEGER NOT NULL DEFAULT 0,
    "star5" INTEGER NOT NULL DEFAULT 0,
    "last_rated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_rating_aggregates_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "review_flags" (
    "id" UUID NOT NULL,
    "ride_rating_id" UUID NOT NULL,
    "flagged_by" UUID,
    "reason" TEXT NOT NULL,
    "status" "ReviewFlagStatus" NOT NULL DEFAULT 'PENDING',
    "moderator_id" UUID,
    "moderator_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "review_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_responses" (
    "id" UUID NOT NULL,
    "ride_rating_id" UUID NOT NULL,
    "responder_id" UUID NOT NULL,
    "response_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" "TicketPriority" NOT NULL,
    "first_response_mins" INTEGER NOT NULL,
    "resolution_mins" INTEGER NOT NULL,
    "business_hours_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "default_priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "sla_policy_id" UUID,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_agents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "display_name" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "max_concurrent" SMALLINT NOT NULL DEFAULT 10,
    "active_tickets" INTEGER NOT NULL DEFAULT 0,
    "skills" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "ticket_number" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "category_id" UUID,
    "ride_id" UUID,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "channel" "TicketChannel" NOT NULL DEFAULT 'APP',
    "assigned_agent_id" UUID,
    "first_response_at" TIMESTAMP(3),
    "sla_due_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "reopened_count" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_type" "TicketMessageAuthor" NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_assignments" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "assigned_by" UUID,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "ticket_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_escalations" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_agent_id" UUID,
    "to_agent_id" UUID,
    "level" SMALLINT NOT NULL DEFAULT 1,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_canned_responses" (
    "id" UUID NOT NULL,
    "category_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_number" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "is_phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "date_of_birth" DATE,
    "gender" TEXT,
    "profile_image" TEXT,
    "language_code" TEXT DEFAULT 'en',
    "referral_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" TEXT,
    "platform" "AppPlatform",
    "trust_state" "DeviceTrustState" NOT NULL DEFAULT 'REGISTERED',
    "device_fingerprint" TEXT,
    "is_rooted" BOOLEAN NOT NULL DEFAULT false,
    "is_jailbroken" BOOLEAN NOT NULL DEFAULT false,
    "fcm_token" TEXT,
    "app_version" TEXT,
    "os_version" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "contact_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "relationship" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_places" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT,
    "building_name" TEXT,
    "landmark" TEXT,
    "floor" TEXT,
    "instructions" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "location" geography(Point,4326),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passenger_capacity" SMALLINT,
    "luggage_capacity" SMALLINT,
    "minimum_fare" DECIMAL(10,2),
    "base_fare" DECIMAL(10,2),
    "per_km_rate" DECIMAL(10,2),
    "per_minute_rate" DECIMAL(10,2),
    "waiting_charge" DECIMAL(10,2),
    "cancellation_charge" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "registration_number" TEXT NOT NULL,
    "registration_state" TEXT,
    "vin" TEXT,
    "make" TEXT,
    "model" TEXT,
    "manufacturing_year" SMALLINT,
    "color" TEXT,
    "fuel_type" TEXT,
    "seating_capacity" SMALLINT,
    "vehicle_type_id" UUID NOT NULL,
    "owner_name" TEXT,
    "owner_phone" TEXT,
    "current_odometer" INTEGER,
    "current_driver_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_assignments" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),
    "reason" TEXT,
    "assigned_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_documents" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_number" TEXT,
    "file_url" TEXT NOT NULL,
    "issued_at" DATE,
    "expires_at" DATE,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_images" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "image_type" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspections" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "inspected_by" UUID,
    "inspected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checklist" JSONB,
    "result" TEXT NOT NULL,
    "notes" TEXT,

    CONSTRAINT "vehicle_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_logs" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "workshop" TEXT,
    "description" TEXT,
    "cost" DECIMAL(10,2),
    "odometer" INTEGER,
    "next_due_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_logs" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "fuel_amount" DECIMAL(8,2),
    "fuel_cost" DECIMAL(10,2),
    "fuel_station" TEXT,
    "odometer" INTEGER,
    "logged_at" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claims" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "claim_number" TEXT,
    "insurance_company" TEXT,
    "status" TEXT,
    "amount" DECIMAL(12,2),
    "accident_date" DATE,
    "settlement_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accident_reports" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID,
    "ride_id" UUID,
    "police_report" TEXT,
    "description" TEXT,
    "location" geography(Point,4326),
    "images" JSONB,
    "witnesses" JSONB,
    "occurred_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accident_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_topups" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "payment_intent_id" UUID,
    "payment_transaction_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gateway" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "wallet_topups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "bank_account_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "payout_id" UUID,
    "rejection_reason" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_holds" (
    "id" UUID NOT NULL,
    "wallet_type" TEXT NOT NULL,
    "wallet_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reference_type" TEXT,
    "reference_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "wallet_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transfers" (
    "id" UUID NOT NULL,
    "from_wallet_type" TEXT NOT NULL,
    "from_wallet_id" UUID,
    "to_wallet_type" TEXT NOT NULL,
    "to_wallet_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "ledger_group" UUID,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashback_campaigns" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "trigger_event" TEXT NOT NULL,
    "reward_type" TEXT NOT NULL,
    "reward_value" DECIMAL(10,2) NOT NULL,
    "max_reward" DECIMAL(10,2),
    "min_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_budget" DECIMAL(14,2),
    "used_budget" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cashback_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashback_grants" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_type" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "wallet_id" UUID,
    "ride_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credited_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "cashback_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_adjustments" (
    "id" UUID NOT NULL,
    "wallet_type" TEXT NOT NULL,
    "wallet_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID,
    "approved_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "wallet_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_reconciliations" (
    "id" UUID NOT NULL,
    "wallet_type" TEXT NOT NULL,
    "wallet_id" UUID NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "stored_balance" DECIMAL(14,2) NOT NULL,
    "computed_balance" DECIMAL(14,2) NOT NULL,
    "difference" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_slug_key" ON "roles"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "admin_activity_logs_actor_id_created_at_idx" ON "admin_activity_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_activity_logs_entity_type_entity_id_idx" ON "admin_activity_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_field_changes_activity_log_id_idx" ON "audit_field_changes"("activity_log_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "feature_flag_overrides_flag_id_idx" ON "feature_flag_overrides"("flag_id");

-- CreateIndex
CREATE INDEX "feature_flag_overrides_user_id_idx" ON "feature_flag_overrides"("user_id");

-- CreateIndex
CREATE INDEX "admin_sessions_user_id_idx" ON "admin_sessions"("user_id");

-- CreateIndex
CREATE INDEX "api_keys_prefix_idx" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "cities_code_key" ON "cities"("code");

-- CreateIndex
CREATE INDEX "service_zones_city_id_idx" ON "service_zones"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_versions_platform_version_key" ON "app_versions"("platform", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_name_key" ON "scheduled_jobs"("name");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries"("endpoint_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_rules_name_key" ON "rate_limit_rules"("name");

-- CreateIndex
CREATE UNIQUE INDEX "data_retention_policies_table_name_key" ON "data_retention_policies"("table_name");

-- CreateIndex
CREATE UNIQUE INDEX "event_types_code_key" ON "event_types"("code");

-- CreateIndex
CREATE INDEX "daily_metrics_metric_key_metric_date_idx" ON "daily_metrics"("metric_key", "metric_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_metrics_metric_date_metric_key_city_code_key" ON "daily_metrics"("metric_date", "metric_key", "city_code");

-- CreateIndex
CREATE UNIQUE INDEX "funnels_code_key" ON "funnels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "funnel_steps_funnel_id_step_order_key" ON "funnel_steps"("funnel_id", "step_order");

-- CreateIndex
CREATE UNIQUE INDEX "cohorts_code_key" ON "cohorts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cohort_retention_cohort_id_period_number_key" ON "cohort_retention"("cohort_id", "period_number");

-- CreateIndex
CREATE INDEX "kpi_snapshots_snapshot_at_idx" ON "kpi_snapshots"("snapshot_at");

-- CreateIndex
CREATE INDEX "dashboard_widgets_dashboard_key_idx" ON "dashboard_widgets"("dashboard_key");

-- CreateIndex
CREATE INDEX "report_exports_status_idx" ON "report_exports"("status");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "otp_verifications_phone_number_idx" ON "otp_verifications"("phone_number");

-- CreateIndex
CREATE INDEX "otp_verifications_created_at_idx" ON "otp_verifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "drivers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_driver_code_key" ON "drivers"("driver_code");

-- CreateIndex
CREATE INDEX "drivers_verification_status_idx" ON "drivers"("verification_status");

-- CreateIndex
CREATE INDEX "drivers_is_available_idx" ON "drivers"("is_available");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_driver_id_key" ON "driver_profiles"("driver_id");

-- CreateIndex
CREATE INDEX "driver_documents_driver_id_idx" ON "driver_documents"("driver_id");

-- CreateIndex
CREATE INDEX "driver_documents_document_type_idx" ON "driver_documents"("document_type");

-- CreateIndex
CREATE INDEX "driver_documents_expires_at_idx" ON "driver_documents"("expires_at");

-- CreateIndex
CREATE INDEX "driver_bank_accounts_driver_id_idx" ON "driver_bank_accounts"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_wallets_driver_id_key" ON "driver_wallets"("driver_id");

-- CreateIndex
CREATE INDEX "driver_wallet_transactions_wallet_id_idx" ON "driver_wallet_transactions"("wallet_id");

-- CreateIndex
CREATE INDEX "driver_wallet_transactions_driver_id_created_at_idx" ON "driver_wallet_transactions"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_shift_logs_driver_id_shift_start_idx" ON "driver_shift_logs"("driver_id", "shift_start");

-- CreateIndex
CREATE INDEX "notification_preferences_user_id_idx" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_category_channel_key" ON "notification_preferences"("user_id", "category", "channel");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "notifications_reference_type_reference_id_idx" ON "notifications"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries"("notification_id");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries"("status");

-- CreateIndex
CREATE INDEX "in_app_messages_user_id_created_at_idx" ON "in_app_messages"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_campaigns_status_scheduled_at_idx" ON "notification_campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_idx" ON "campaign_recipients"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_user_id_key" ON "campaign_recipients"("campaign_id", "user_id");

-- CreateIndex
CREATE INDEX "payment_methods_user_id_idx" ON "payment_methods"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_wallets_user_id_key" ON "customer_wallets"("user_id");

-- CreateIndex
CREATE INDEX "customer_wallet_transactions_wallet_id_created_at_idx" ON "customer_wallet_transactions"("wallet_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_idempotency_key_key" ON "payment_intents"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_intents_ride_id_idx" ON "payment_intents"("ride_id");

-- CreateIndex
CREATE INDEX "payment_intents_user_id_idx" ON "payment_intents"("user_id");

-- CreateIndex
CREATE INDEX "payment_transactions_intent_id_idx" ON "payment_transactions"("intent_id");

-- CreateIndex
CREATE INDEX "payment_transactions_ride_id_idx" ON "payment_transactions"("ride_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_events_gateway_gateway_event_id_key" ON "gateway_events"("gateway", "gateway_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_transaction_id_idx" ON "refunds"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_ledger_entries_entry_group_idx" ON "payment_ledger_entries"("entry_group");

-- CreateIndex
CREATE INDEX "payment_ledger_entries_account_account_ref_id_created_at_idx" ON "payment_ledger_entries"("account", "account_ref_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_settlements_driver_id_period_start_period_end_key" ON "driver_settlements"("driver_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "driver_payouts_idempotency_key_key" ON "driver_payouts"("idempotency_key");

-- CreateIndex
CREATE INDEX "driver_payouts_driver_id_idx" ON "driver_payouts"("driver_id");

-- CreateIndex
CREATE INDEX "payout_items_payout_id_idx" ON "payout_items"("payout_id");

-- CreateIndex
CREATE INDEX "chargebacks_transaction_id_idx" ON "chargebacks"("transaction_id");

-- CreateIndex
CREATE INDEX "chargebacks_status_idx" ON "chargebacks"("status");

-- CreateIndex
CREATE INDEX "pricing_rules_city_code_vehicle_type_id_idx" ON "pricing_rules"("city_code", "vehicle_type_id");

-- CreateIndex
CREATE INDEX "surge_zones_city_code_idx" ON "surge_zones"("city_code");

-- CreateIndex
CREATE INDEX "surge_windows_zone_id_starts_at_idx" ON "surge_windows"("zone_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_is_active_valid_from_valid_to_idx" ON "promotions"("is_active", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_idx" ON "promotion_redemptions"("promotion_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_user_id_idx" ON "promotion_redemptions"("user_id");

-- CreateIndex
CREATE INDEX "tax_configs_city_code_is_active_idx" ON "tax_configs"("city_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "promo_campaigns_code_key" ON "promo_campaigns"("code");

-- CreateIndex
CREATE INDEX "promo_campaigns_status_starts_at_idx" ON "promo_campaigns"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "audience_segments_code_key" ON "audience_segments"("code");

-- CreateIndex
CREATE INDEX "campaign_targets_segment_id_idx" ON "campaign_targets"("segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_targets_campaign_id_segment_id_key" ON "campaign_targets"("campaign_id", "segment_id");

-- CreateIndex
CREATE INDEX "coupon_batches_campaign_id_idx" ON "coupon_batches"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_batch_id_idx" ON "coupons"("batch_id");

-- CreateIndex
CREATE INDEX "coupons_user_id_idx" ON "coupons"("user_id");

-- CreateIndex
CREATE INDEX "coupons_status_idx" ON "coupons"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_programs_code_key" ON "referral_programs"("code");

-- CreateIndex
CREATE INDEX "referral_programs_is_active_valid_from_valid_to_idx" ON "referral_programs"("is_active", "valid_from", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_codes_user_id_idx" ON "referral_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_user_id_program_id_key" ON "referral_codes"("user_id", "program_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_id_idx" ON "referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_program_id_referee_id_key" ON "referrals"("program_id", "referee_id");

-- CreateIndex
CREATE INDEX "referral_rewards_referral_id_idx" ON "referral_rewards"("referral_id");

-- CreateIndex
CREATE INDEX "referral_rewards_user_id_idx" ON "referral_rewards"("user_id");

-- CreateIndex
CREATE INDEX "referral_milestones_program_id_idx" ON "referral_milestones"("program_id");

-- CreateIndex
CREATE INDEX "referral_fraud_flags_referral_id_idx" ON "referral_fraud_flags"("referral_id");

-- CreateIndex
CREATE INDEX "ride_requests_customer_id_idx" ON "ride_requests"("customer_id");

-- CreateIndex
CREATE INDEX "ride_requests_status_idx" ON "ride_requests"("status");

-- CreateIndex
CREATE INDEX "ride_dispatches_driver_id_idx" ON "ride_dispatches"("driver_id");

-- CreateIndex
CREATE INDEX "ride_dispatches_response_idx" ON "ride_dispatches"("response");

-- CreateIndex
CREATE UNIQUE INDEX "ride_dispatches_request_id_driver_id_key" ON "ride_dispatches"("request_id", "driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "rides_ride_code_key" ON "rides"("ride_code");

-- CreateIndex
CREATE INDEX "rides_customer_id_idx" ON "rides"("customer_id");

-- CreateIndex
CREATE INDEX "rides_driver_id_idx" ON "rides"("driver_id");

-- CreateIndex
CREATE INDEX "rides_status_idx" ON "rides"("status");

-- CreateIndex
CREATE INDEX "rides_created_at_idx" ON "rides"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ride_stops_ride_id_sequence_key" ON "ride_stops"("ride_id", "sequence");

-- CreateIndex
CREATE INDEX "ride_status_events_ride_id_created_at_idx" ON "ride_status_events"("ride_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ride_fares_ride_id_key" ON "ride_fares"("ride_id");

-- CreateIndex
CREATE INDEX "ride_fare_lines_ride_id_idx" ON "ride_fare_lines"("ride_id");

-- CreateIndex
CREATE UNIQUE INDEX "ride_cancellations_ride_id_key" ON "ride_cancellations"("ride_id");

-- CreateIndex
CREATE INDEX "ride_otps_ride_id_idx" ON "ride_otps"("ride_id");

-- CreateIndex
CREATE UNIQUE INDEX "ride_receipts_ride_id_key" ON "ride_receipts"("ride_id");

-- CreateIndex
CREATE UNIQUE INDEX "ride_receipts_receipt_number_key" ON "ride_receipts"("receipt_number");

-- CreateIndex
CREATE INDEX "ride_payments_ride_id_idx" ON "ride_payments"("ride_id");

-- CreateIndex
CREATE UNIQUE INDEX "ride_ratings_ride_id_rated_by_key" ON "ride_ratings"("ride_id", "rated_by");

-- CreateIndex
CREATE INDEX "ride_promos_applied_ride_id_idx" ON "ride_promos_applied"("ride_id");

-- CreateIndex
CREATE INDEX "scheduled_rides_scheduled_for_idx" ON "scheduled_rides"("scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "ride_route_plan_ride_id_key" ON "ride_route_plan"("ride_id");

-- CreateIndex
CREATE INDEX "ride_wait_events_ride_id_idx" ON "ride_wait_events"("ride_id");

-- CreateIndex
CREATE INDEX "ride_disputes_ride_id_idx" ON "ride_disputes"("ride_id");

-- CreateIndex
CREATE INDEX "ride_disputes_status_idx" ON "ride_disputes"("status");

-- CreateIndex
CREATE INDEX "chat_conversations_ride_id_idx" ON "chat_conversations"("ride_id");

-- CreateIndex
CREATE INDEX "chat_conversations_status_last_message_at_idx" ON "chat_conversations"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "chat_participants_user_id_idx" ON "chat_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_participants_conversation_id_user_id_key" ON "chat_participants"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_created_at_idx" ON "chat_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_messages_sender_id_idx" ON "chat_messages"("sender_id");

-- CreateIndex
CREATE INDEX "chat_attachments_message_id_idx" ON "chat_attachments"("message_id");

-- CreateIndex
CREATE INDEX "chat_read_receipts_user_id_idx" ON "chat_read_receipts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_read_receipts_message_id_user_id_key" ON "chat_read_receipts"("message_id", "user_id");

-- CreateIndex
CREATE INDEX "chat_blocks_blocked_id_idx" ON "chat_blocks"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_blocks_blocker_id_blocked_id_key" ON "chat_blocks"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "chat_reports_status_idx" ON "chat_reports"("status");

-- CreateIndex
CREATE INDEX "chat_reports_reported_id_idx" ON "chat_reports"("reported_id");

-- CreateIndex
CREATE UNIQUE INDEX "rating_tags_code_key" ON "rating_tags"("code");

-- CreateIndex
CREATE INDEX "review_tag_assignments_tag_id_idx" ON "review_tag_assignments"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_tag_assignments_ride_rating_id_tag_id_key" ON "review_tag_assignments"("ride_rating_id", "tag_id");

-- CreateIndex
CREATE INDEX "review_flags_ride_rating_id_idx" ON "review_flags"("ride_rating_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_responses_ride_rating_id_key" ON "review_responses"("ride_rating_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_categories_code_key" ON "support_categories"("code");

-- CreateIndex
CREATE INDEX "support_categories_parent_id_idx" ON "support_categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "support_agents_user_id_key" ON "support_agents"("user_id");

-- CreateIndex
CREATE INDEX "support_agents_status_idx" ON "support_agents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "support_tickets_user_id_idx" ON "support_tickets"("user_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "support_tickets_assigned_agent_id_idx" ON "support_tickets"("assigned_agent_id");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticket_id_created_at_idx" ON "support_ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ticket_assignments_ticket_id_idx" ON "ticket_assignments"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_assignments_agent_id_idx" ON "ticket_assignments"("agent_id");

-- CreateIndex
CREATE INDEX "ticket_escalations_ticket_id_idx" ON "ticket_escalations"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_referral_code_key" ON "user_profiles"("referral_code");

-- CreateIndex
CREATE INDEX "user_devices_user_id_idx" ON "user_devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_devices_user_id_device_id_key" ON "user_devices"("user_id", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_types_code_key" ON "vehicle_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_number_key" ON "vehicles"("registration_number");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key" ON "vehicles"("vin");

-- CreateIndex
CREATE INDEX "vehicles_vehicle_type_id_idx" ON "vehicles"("vehicle_type_id");

-- CreateIndex
CREATE INDEX "vehicles_is_active_idx" ON "vehicles"("is_active");

-- CreateIndex
CREATE INDEX "vehicle_assignments_driver_id_idx" ON "vehicle_assignments"("driver_id");

-- CreateIndex
CREATE INDEX "vehicle_assignments_vehicle_id_idx" ON "vehicle_assignments"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_documents_vehicle_id_idx" ON "vehicle_documents"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_documents_expires_at_idx" ON "vehicle_documents"("expires_at");

-- CreateIndex
CREATE INDEX "vehicle_images_vehicle_id_idx" ON "vehicle_images"("vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_inspections_vehicle_id_idx" ON "vehicle_inspections"("vehicle_id");

-- CreateIndex
CREATE INDEX "maintenance_logs_vehicle_id_idx" ON "maintenance_logs"("vehicle_id");

-- CreateIndex
CREATE INDEX "fuel_logs_vehicle_id_idx" ON "fuel_logs"("vehicle_id");

-- CreateIndex
CREATE INDEX "insurance_claims_vehicle_id_idx" ON "insurance_claims"("vehicle_id");

-- CreateIndex
CREATE INDEX "accident_reports_vehicle_id_idx" ON "accident_reports"("vehicle_id");

-- CreateIndex
CREATE INDEX "accident_reports_driver_id_idx" ON "accident_reports"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_idempotency_key_key" ON "wallet_topups"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_topups_wallet_id_idx" ON "wallet_topups"("wallet_id");

-- CreateIndex
CREATE INDEX "wallet_topups_user_id_idx" ON "wallet_topups"("user_id");

-- CreateIndex
CREATE INDEX "withdrawal_requests_driver_id_idx" ON "withdrawal_requests"("driver_id");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_idx" ON "withdrawal_requests"("status");

-- CreateIndex
CREATE INDEX "wallet_holds_wallet_type_wallet_id_idx" ON "wallet_holds"("wallet_type", "wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transfers_idempotency_key_key" ON "wallet_transfers"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "cashback_campaigns_code_key" ON "cashback_campaigns"("code");

-- CreateIndex
CREATE INDEX "cashback_campaigns_is_active_valid_from_valid_to_idx" ON "cashback_campaigns"("is_active", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "cashback_grants_campaign_id_idx" ON "cashback_grants"("campaign_id");

-- CreateIndex
CREATE INDEX "cashback_grants_user_id_idx" ON "cashback_grants"("user_id");

-- CreateIndex
CREATE INDEX "wallet_adjustments_wallet_type_wallet_id_idx" ON "wallet_adjustments"("wallet_type", "wallet_id");

-- CreateIndex
CREATE INDEX "wallet_adjustments_status_idx" ON "wallet_adjustments"("status");

-- CreateIndex
CREATE INDEX "wallet_reconciliations_wallet_type_wallet_id_as_of_idx" ON "wallet_reconciliations"("wallet_type", "wallet_id", "as_of");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_activity_logs" ADD CONSTRAINT "admin_activity_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_field_changes" ADD CONSTRAINT "audit_field_changes_activity_log_id_fkey" FOREIGN KEY ("activity_log_id") REFERENCES "admin_activity_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "feature_flags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_zones" ADD CONSTRAINT "service_zones_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funnel_steps" ADD CONSTRAINT "funnel_steps_funnel_id_fkey" FOREIGN KEY ("funnel_id") REFERENCES "funnels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cohort_retention" ADD CONSTRAINT "cohort_retention_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "cohorts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "user_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_rotated_from_fkey" FOREIGN KEY ("rotated_from") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_documents" ADD CONSTRAINT "driver_documents_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_bank_accounts" ADD CONSTRAINT "driver_bank_accounts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallets" ADD CONSTRAINT "driver_wallets_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_wallet_transactions" ADD CONSTRAINT "driver_wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "driver_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_online_status" ADD CONSTRAINT "driver_online_status_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_locations" ADD CONSTRAINT "driver_locations_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shift_logs" ADD CONSTRAINT "driver_shift_logs_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "user_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_messages" ADD CONSTRAINT "in_app_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_app_messages" ADD CONSTRAINT "in_app_messages_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_campaigns" ADD CONSTRAINT "notification_campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "notification_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_wallet_transactions" ADD CONSTRAINT "customer_wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "customer_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_settlements" ADD CONSTRAINT "driver_settlements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_payouts" ADD CONSTRAINT "driver_payouts_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "driver_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "driver_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chargebacks" ADD CONSTRAINT "chargebacks_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chargebacks" ADD CONSTRAINT "chargebacks_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surge_windows" ADD CONSTRAINT "surge_windows_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "surge_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surge_windows" ADD CONSTRAINT "surge_windows_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_applicable_vehicle_type_fkey" FOREIGN KEY ("applicable_vehicle_type") REFERENCES "vehicle_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "audience_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_batches" ADD CONSTRAINT "coupon_batches_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_batches" ADD CONSTRAINT "coupon_batches_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "coupon_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_redeemed_ride_id_fkey" FOREIGN KEY ("redeemed_ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_banners" ADD CONSTRAINT "promo_banners_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "promo_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referral_code_id_fkey" FOREIGN KEY ("referral_code_id") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_milestones" ADD CONSTRAINT "referral_milestones_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "referral_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_fraud_flags" ADD CONSTRAINT "referral_fraud_flags_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_fraud_flags" ADD CONSTRAINT "referral_fraud_flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_requests" ADD CONSTRAINT "ride_requests_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_dispatches" ADD CONSTRAINT "ride_dispatches_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_dispatches" ADD CONSTRAINT "ride_dispatches_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_dispatches" ADD CONSTRAINT "ride_dispatches_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rides" ADD CONSTRAINT "rides_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rides" ADD CONSTRAINT "rides_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rides" ADD CONSTRAINT "rides_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rides" ADD CONSTRAINT "rides_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rides" ADD CONSTRAINT "rides_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_stops" ADD CONSTRAINT "ride_stops_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_status_events" ADD CONSTRAINT "ride_status_events_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_fares" ADD CONSTRAINT "ride_fares_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_fare_lines" ADD CONSTRAINT "ride_fare_lines_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_cancellations" ADD CONSTRAINT "ride_cancellations_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_otps" ADD CONSTRAINT "ride_otps_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_receipts" ADD CONSTRAINT "ride_receipts_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_payments" ADD CONSTRAINT "ride_payments_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_ratings" ADD CONSTRAINT "ride_ratings_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_promos_applied" ADD CONSTRAINT "ride_promos_applied_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_rides" ADD CONSTRAINT "scheduled_rides_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_route_plan" ADD CONSTRAINT "ride_route_plan_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_wait_events" ADD CONSTRAINT "ride_wait_events_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_disputes" ADD CONSTRAINT "ride_disputes_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_read_receipts" ADD CONSTRAINT "chat_read_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_read_receipts" ADD CONSTRAINT "chat_read_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_blocks" ADD CONSTRAINT "chat_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_blocks" ADD CONSTRAINT "chat_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tag_assignments" ADD CONSTRAINT "review_tag_assignments_ride_rating_id_fkey" FOREIGN KEY ("ride_rating_id") REFERENCES "ride_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tag_assignments" ADD CONSTRAINT "review_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "rating_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_rating_aggregates" ADD CONSTRAINT "driver_rating_aggregates_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_rating_aggregates" ADD CONSTRAINT "customer_rating_aggregates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_ride_rating_id_fkey" FOREIGN KEY ("ride_rating_id") REFERENCES "ride_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_flagged_by_fkey" FOREIGN KEY ("flagged_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_ride_rating_id_fkey" FOREIGN KEY ("ride_rating_id") REFERENCES "ride_ratings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_responder_id_fkey" FOREIGN KEY ("responder_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "support_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_categories" ADD CONSTRAINT "support_categories_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_agents" ADD CONSTRAINT "support_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "support_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "support_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_escalations" ADD CONSTRAINT "ticket_escalations_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_escalations" ADD CONSTRAINT "ticket_escalations_from_agent_id_fkey" FOREIGN KEY ("from_agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_escalations" ADD CONSTRAINT "ticket_escalations_to_agent_id_fkey" FOREIGN KEY ("to_agent_id") REFERENCES "support_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_canned_responses" ADD CONSTRAINT "support_canned_responses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "support_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_images" ADD CONSTRAINT "vehicle_images_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_logs" ADD CONSTRAINT "fuel_logs_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "customer_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "driver_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "driver_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_grants" ADD CONSTRAINT "cashback_grants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "cashback_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_grants" ADD CONSTRAINT "cashback_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashback_grants" ADD CONSTRAINT "cashback_grants_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- Raw-SQL invariants that Prisma cannot express (auth doc 03 §4).
-- Hand-authored and reviewed; enforced at the database level (Vol 6 principle #5).
-- Tables are empty at init, so plain CREATE INDEX is correct here; the
-- expand/contract playbook (doc 03 §7) uses CREATE INDEX CONCURRENTLY on a
-- live database instead.
-- ============================================================================

-- AUTH-INV-1: at most one ACTIVE (non-soft-deleted) account per phone number.
-- A plain UNIQUE would block re-registration after a soft-delete, so it is PARTIAL.
CREATE UNIQUE INDEX "uq_users_phone_active"
    ON "users" ("phone_number") WHERE "deleted_at" IS NULL;

-- OD-2: at most one ACTIVE assignment per (user, role); re-grant allowed after revoke.
CREATE UNIQUE INDEX "uq_user_role_active"
    ON "user_roles" ("user_id", "role_id") WHERE "revoked_at" IS NULL;

-- Session cap (doc 02 §5.1): fast count of a user's live sessions.
CREATE INDEX "ix_sessions_user_active"
    ON "user_sessions" ("user_id") WHERE "revoked_at" IS NULL;

-- Housekeeping sweeps (retention doc 03 §6): find purgeable rows cheaply.
CREATE INDEX "ix_refresh_expired"
    ON "refresh_tokens" ("expires_at") WHERE "revoked_at" IS NULL;
