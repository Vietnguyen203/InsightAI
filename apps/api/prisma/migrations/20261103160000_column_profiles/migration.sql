-- Phase 2d: column profiling (derived statistics per dataset version).

-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "dataset_versions" ADD COLUMN     "profile_status" "ProfileStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "profiled_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "column_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "dataset_column_id" UUID NOT NULL,
    "stats" JSONB NOT NULL,
    "approximate" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "column_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "column_profiles_dataset_column_id_key" ON "column_profiles"("dataset_column_id");

-- CreateIndex
CREATE INDEX "column_profiles_dataset_version_id_idx" ON "column_profiles"("dataset_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "column_profiles_organization_id_dataset_column_id_key" ON "column_profiles"("organization_id", "dataset_column_id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_columns_organization_id_id_key" ON "dataset_columns"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "column_profiles" ADD CONSTRAINT "column_profiles_organization_id_dataset_version_id_fkey" FOREIGN KEY ("organization_id", "dataset_version_id") REFERENCES "dataset_versions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "column_profiles" ADD CONSTRAINT "column_profiles_organization_id_dataset_column_id_fkey" FOREIGN KEY ("organization_id", "dataset_column_id") REFERENCES "dataset_columns"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation. Profiles are derived data and may be recomputed (DELETE allowed).
ALTER TABLE app.column_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.column_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.column_profiles
  USING (organization_id = app.ctx_uuid('app.org_id'))
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id'));
