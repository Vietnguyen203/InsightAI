-- Phase 2c: datasets, versions, columns, uploads and import jobs.
-- Generated DDL (prisma migrate diff) followed by data-plane helpers, RLS and grants.

-- CreateEnum
CREATE TYPE "DatasetStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DatasetVersionOrigin" AS ENUM ('IMPORT', 'CLEANING');

-- CreateEnum
CREATE TYPE "ColumnDataType" AS ENUM ('TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'TIMESTAMP');

-- CreateTable
CREATE TABLE "data_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FILE_UPLOAD',
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_format" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "data_key" TEXT NOT NULL,
    "status" "DatasetStatus" NOT NULL DEFAULT 'DRAFT',
    "active_version_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "origin" "DatasetVersionOrigin" NOT NULL,
    "parent_version_id" UUID,
    "import_job_id" UUID,
    "physical_table" TEXT NOT NULL,
    "raw_table" TEXT,
    "row_count" BIGINT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_columns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "original_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "physical_name" TEXT NOT NULL,
    "data_type" "ColumnDataType" NOT NULL,
    "inferred_type" "ColumnDataType" NOT NULL,
    "type_confidence" DECIMAL(5,4) NOT NULL,
    "detected_format" TEXT,
    "non_empty_count" BIGINT NOT NULL,
    "invalid_count" BIGINT NOT NULL,

    CONSTRAINT "dataset_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "data_source_id" UUID NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "options" JSONB NOT NULL DEFAULT '{}',
    "table_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rows_read" BIGINT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "error" JSONB,
    "requested_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_storage_key_key" ON "data_sources"("storage_key");

-- CreateIndex
CREATE INDEX "data_sources_organization_id_sha256_idx" ON "data_sources"("organization_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "data_sources_organization_id_id_key" ON "data_sources"("organization_id", "id");

-- CreateIndex
CREATE INDEX "datasets_organization_id_updated_at_idx" ON "datasets"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "datasets_organization_id_id_key" ON "datasets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "datasets_organization_id_data_key_key" ON "datasets"("organization_id", "data_key");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_import_job_id_key" ON "dataset_versions"("import_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_organization_id_id_key" ON "dataset_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_dataset_id_version_no_key" ON "dataset_versions"("dataset_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_versions_organization_id_physical_table_key" ON "dataset_versions"("organization_id", "physical_table");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_columns_dataset_version_id_name_key" ON "dataset_columns"("dataset_version_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_columns_dataset_version_id_ordinal_key" ON "dataset_columns"("dataset_version_id", "ordinal");

-- CreateIndex
CREATE INDEX "import_jobs_organization_id_dataset_id_created_at_idx" ON "import_jobs"("organization_id", "dataset_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_organization_id_id_key" ON "import_jobs"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_organization_id_active_version_id_fkey" FOREIGN KEY ("organization_id", "active_version_id") REFERENCES "dataset_versions"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_columns" ADD CONSTRAINT "dataset_columns_organization_id_dataset_version_id_fkey" FOREIGN KEY ("organization_id", "dataset_version_id") REFERENCES "dataset_versions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organization_id_data_source_id_fkey" FOREIGN KEY ("organization_id", "data_source_id") REFERENCES "data_sources"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- Data-plane helper functions (schema "dp"). Used by import/cleaning SQL that runs as a
-- tenant writer role. Pure functions: they read no tables and only convert values,
-- returning NULL instead of raising when a value cannot be converted.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS dp;
REVOKE ALL ON SCHEMA dp FROM PUBLIC;
GRANT USAGE ON SCHEMA dp TO PUBLIC;

CREATE FUNCTION dp.try_bigint(v text) RETURNS bigint
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN v::bigint;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

CREATE FUNCTION dp.try_numeric(v text) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN v::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- to_date raises on impossible dates such as 31/02/2026; those become NULL (counted as invalid).
CREATE FUNCTION dp.try_date(v text, fmt text) RETURNS date
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN to_date(v, fmt);
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- Wall-clock timestamp from a day/month-first format; seconds are optional in the input.
CREATE FUNCTION dp.try_timestamp(v text, fmt text) RETURNS timestamp
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  effective_fmt text := CASE WHEN v ~ ':[0-9]{2}:[0-9]{2}$' THEN fmt ELSE replace(fmt, ':SS', '') END;
BEGIN
  RETURN to_timestamp(v, effective_fmt) AT TIME ZONE 'UTC';
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- ISO 8601. Values with an offset (or Z) are converted to the organization's wall-clock time;
-- values without an offset are taken as wall-clock time already.
CREATE FUNCTION dp.try_timestamp_iso(v text, tz text) RETURNS timestamp
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF v ~* '(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN
    RETURN (v::timestamptz) AT TIME ZONE tz;
  END IF;
  RETURN v::timestamp;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Row-Level Security: every data-management table is tenant-scoped.
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['data_sources', 'datasets', 'dataset_versions', 'dataset_columns', 'import_jobs']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;

-- Uploaded files, datasets, versions and import history are never deleted by the application
-- (datasets are archived). Removing data is an explicit, reviewed operation outside the app.
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'datasets' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format(
      'REVOKE DELETE ON app.data_sources, app.datasets, app.dataset_versions, app.dataset_columns, app.import_jobs FROM %I',
      app_role);
  END LOOP;
END $$;
