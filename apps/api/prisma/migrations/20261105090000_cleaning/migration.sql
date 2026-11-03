-- Phase 3b: cleaning jobs and operations; dataset versions remember the job that produced them.
-- CreateEnum
CREATE TYPE "CleaningJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "dataset_versions" ADD COLUMN     "cleaning_job_id" UUID;

-- CreateTable
CREATE TABLE "cleaning_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "status" "CleaningJobStatus" NOT NULL DEFAULT 'PENDING',
    "table_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "requested_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "cleaning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cleaning_operations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "cleaning_job_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "op_type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "affected_rows" BIGINT,
    "removed_rows" BIGINT,

    CONSTRAINT "cleaning_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cleaning_jobs_organization_id_dataset_id_created_at_idx" ON "cleaning_jobs"("organization_id", "dataset_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_jobs_organization_id_id_key" ON "cleaning_jobs"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cleaning_operations_cleaning_job_id_seq_key" ON "cleaning_operations"("cleaning_job_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_cleaning_job_id_key" ON "dataset_versions"("cleaning_job_id");

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_cleaning_job_id_fkey" FOREIGN KEY ("cleaning_job_id") REFERENCES "cleaning_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_jobs" ADD CONSTRAINT "cleaning_jobs_organization_id_source_version_id_fkey" FOREIGN KEY ("organization_id", "source_version_id") REFERENCES "dataset_versions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_operations" ADD CONSTRAINT "cleaning_operations_organization_id_cleaning_job_id_fkey" FOREIGN KEY ("organization_id", "cleaning_job_id") REFERENCES "cleaning_jobs"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cleaning_jobs', 'cleaning_operations']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;

-- Cleaning history is evidence of how a version was produced: it is never deleted, and the
-- operation list is immutable (only the per-operation counts are filled in by the worker).
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'quality_rules' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE DELETE ON app.cleaning_jobs, app.cleaning_operations FROM %I', app_role);
    EXECUTE format('REVOKE UPDATE ON app.cleaning_operations FROM %I', app_role);
    EXECUTE format('GRANT UPDATE (affected_rows, removed_rows) ON app.cleaning_operations TO %I', app_role);
  END LOOP;
END $$;
