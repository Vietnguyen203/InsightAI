-- Phase 4b: access policies and query history.
-- CreateEnum
CREATE TYPE "QueryStatus" AS ENUM ('SUCCEEDED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "semantic_access_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "roles" TEXT[],
    "member_access" JSONB,
    "row_filter" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_history" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "semantic_model_id" UUID,
    "model_revision" INTEGER,
    "semantic_query" JSONB NOT NULL,
    "compiled_sql" TEXT,
    "dataset_version_ids" TEXT[],
    "policies_applied" TEXT[],
    "status" "QueryStatus" NOT NULL,
    "error_code" TEXT,
    "row_count" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "semantic_access_policies_organization_id_id_key" ON "semantic_access_policies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_access_policies_semantic_model_id_name_key" ON "semantic_access_policies"("semantic_model_id", "name");

-- CreateIndex
CREATE INDEX "query_history_organization_id_created_at_idx" ON "query_history"("organization_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "semantic_access_policies" ADD CONSTRAINT "semantic_access_policies_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['semantic_access_policies', 'query_history']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;

-- Query history is evidence: the application cannot rewrite or delete it.
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'quality_rules' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON app.query_history FROM %I', app_role);
  END LOOP;
END $$;
