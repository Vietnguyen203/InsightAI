-- Phase 4c: metrics with immutable versions, synonyms; query history records metric versions.
-- CreateEnum
CREATE TYPE "MetricStatus" AS ENUM ('ACTIVE', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "MetricVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'DEPRECATED');

-- AlterTable
ALTER TABLE "query_history" ADD COLUMN     "metric_version_ids" TEXT[];

-- CreateTable
CREATE TABLE "metrics" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "status" "MetricStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "metric_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "MetricVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "type" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "business_definition" TEXT,
    "unit" TEXT,
    "format" TEXT NOT NULL DEFAULT 'number',
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metric_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_synonyms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "member_kind" TEXT NOT NULL,
    "member" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "phrase_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "semantic_synonyms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metrics_organization_id_id_key" ON "metrics"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_semantic_model_id_key_key" ON "metrics"("semantic_model_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "metric_versions_organization_id_id_key" ON "metric_versions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_versions_metric_id_version_no_key" ON "metric_versions"("metric_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_synonyms_organization_id_id_key" ON "semantic_synonyms"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_synonyms_semantic_model_id_phrase_normalized_key" ON "semantic_synonyms"("semantic_model_id", "phrase_normalized");

-- AddForeignKey
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_versions" ADD CONSTRAINT "metric_versions_organization_id_metric_id_fkey" FOREIGN KEY ("organization_id", "metric_id") REFERENCES "metrics"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_synonyms" ADD CONSTRAINT "semantic_synonyms_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE app.metrics ADD CONSTRAINT metrics_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE app.metric_versions ADD CONSTRAINT metric_versions_type CHECK (type IN ('SIMPLE', 'RATIO', 'DERIVED'));
ALTER TABLE app.metric_versions ADD CONSTRAINT metric_versions_format CHECK (format IN ('number', 'currency', 'percent'));
ALTER TABLE app.semantic_synonyms ADD CONSTRAINT semantic_synonyms_member_kind CHECK (member_kind IN ('METRIC', 'DIMENSION'));

-- One canonical definition at a time, enforced by the database (docs/SEMANTIC_LAYER_DESIGN.md §7).
CREATE UNIQUE INDEX metric_versions_one_published ON app.metric_versions (metric_id) WHERE status = 'PUBLISHED';
-- At most one draft per metric.
CREATE UNIQUE INDEX metric_versions_one_draft ON app.metric_versions (metric_id) WHERE status = 'DRAFT';

-- A version that left DRAFT is immutable: only its status may change (PUBLISHED → DEPRECATED).
CREATE FUNCTION app.metric_versions_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.definition IS DISTINCT FROM OLD.definition OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.label IS DISTINCT FROM OLD.label OR NEW.unit IS DISTINCT FROM OLD.unit
    OR NEW.format IS DISTINCT FROM OLD.format
    OR NEW.business_definition IS DISTINCT FROM OLD.business_definition
    OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.metric_id IS DISTINCT FROM OLD.metric_id
    OR NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'metric version % is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER metric_versions_immutable BEFORE UPDATE ON app.metric_versions
  FOR EACH ROW EXECUTE FUNCTION app.metric_versions_immutable();

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['metrics', 'metric_versions', 'semantic_synonyms']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;
