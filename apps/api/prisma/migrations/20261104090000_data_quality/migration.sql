-- Phase 3a: data quality rules, checks, results and issue samples.

-- CreateEnum
CREATE TYPE "QualitySeverity" AS ENUM ('info', 'warning', 'error');

-- CreateEnum
CREATE TYPE "QualityCheckStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "QualityCheckTrigger" AS ENUM ('IMPORT', 'MANUAL', 'CLEANING');

-- CreateEnum
CREATE TYPE "QualityStatus" AS ENUM ('UNCHECKED', 'PASSED', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "RuleResultStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'ERROR');

-- AlterTable
ALTER TABLE "dataset_versions" ADD COLUMN     "quality_score" DECIMAL(5,2),
ADD COLUMN     "quality_status" "QualityStatus" NOT NULL DEFAULT 'UNCHECKED';

-- CreateTable
CREATE TABLE "quality_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "rule_type" TEXT NOT NULL,
    "severity" "QualitySeverity" NOT NULL DEFAULT 'warning',
    "weight" INTEGER NOT NULL DEFAULT 1,
    "threshold" DECIMAL(5,4) NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL,
    "system_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_checks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "trigger" "QualityCheckTrigger" NOT NULL,
    "status" "QualityCheckStatus" NOT NULL DEFAULT 'PENDING',
    "score" DECIMAL(5,2),
    "quality_status" "QualityStatus" NOT NULL DEFAULT 'UNCHECKED',
    "dimension_scores" JSONB NOT NULL DEFAULT '{}',
    "rules_total" INTEGER NOT NULL DEFAULT 0,
    "rules_failed" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_check_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quality_check_id" UUID NOT NULL,
    "quality_rule_id" UUID,
    "rule_snapshot" JSONB NOT NULL,
    "status" "RuleResultStatus" NOT NULL,
    "evaluated_count" BIGINT NOT NULL DEFAULT 0,
    "failed_count" BIGINT NOT NULL DEFAULT 0,
    "pass_rate" DECIMAL(7,6),
    "message" TEXT,
    "sample_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quality_check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_issues" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "quality_check_result_id" UUID NOT NULL,
    "row_id" BIGINT NOT NULL,
    "column_name" TEXT,
    "value" TEXT,
    "raw_value" TEXT,

    CONSTRAINT "quality_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quality_rules_organization_id_dataset_id_idx" ON "quality_rules"("organization_id", "dataset_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_rules_organization_id_id_key" ON "quality_rules"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_rules_dataset_id_system_key_key" ON "quality_rules"("dataset_id", "system_key");

-- CreateIndex
CREATE INDEX "quality_checks_organization_id_dataset_id_created_at_idx" ON "quality_checks"("organization_id", "dataset_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quality_checks_dataset_version_id_idx" ON "quality_checks"("dataset_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_checks_organization_id_id_key" ON "quality_checks"("organization_id", "id");

-- CreateIndex
CREATE INDEX "quality_check_results_quality_check_id_idx" ON "quality_check_results"("quality_check_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_check_results_organization_id_id_key" ON "quality_check_results"("organization_id", "id");

-- CreateIndex
CREATE INDEX "quality_issues_quality_check_result_id_row_id_idx" ON "quality_issues"("quality_check_result_id", "row_id");

-- AddForeignKey
ALTER TABLE "quality_rules" ADD CONSTRAINT "quality_rules_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_organization_id_dataset_version_id_fkey" FOREIGN KEY ("organization_id", "dataset_version_id") REFERENCES "dataset_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_check_results" ADD CONSTRAINT "quality_check_results_organization_id_quality_check_id_fkey" FOREIGN KEY ("organization_id", "quality_check_id") REFERENCES "quality_checks"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_check_results" ADD CONSTRAINT "quality_check_results_quality_rule_id_fkey" FOREIGN KEY ("quality_rule_id") REFERENCES "quality_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_organization_id_quality_check_result_id_fkey" FOREIGN KEY ("organization_id", "quality_check_result_id") REFERENCES "quality_check_results"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one queued or running check per dataset version (a second request is a no-op).
CREATE UNIQUE INDEX quality_checks_one_active_per_version
  ON app.quality_checks (dataset_version_id) WHERE status IN ('PENDING', 'RUNNING');

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quality_rules', 'quality_checks', 'quality_check_results', 'quality_issues']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;

-- Check history is evidence: the application cannot delete or rewrite results.
-- Rules are configuration and may be deleted (results keep their snapshot).
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'quality_rules' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE DELETE ON app.quality_checks, app.quality_check_results, app.quality_issues FROM %I', app_role);
    EXECUTE format('REVOKE UPDATE ON app.quality_check_results, app.quality_issues FROM %I', app_role);
  END LOOP;
END $$;
