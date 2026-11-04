-- Phase 4a: semantic models, entities, dimensions, measures and relationships.
-- CreateEnum
CREATE TYPE "SemanticModelStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "SemanticValidationStatus" AS ENUM ('UNVALIDATED', 'VALID', 'WARNING', 'INVALID');

-- CreateEnum
CREATE TYPE "DimensionType" AS ENUM ('CATEGORICAL', 'TIME');

-- CreateEnum
CREATE TYPE "RelationshipCardinality" AS ENUM ('MANY_TO_ONE', 'ONE_TO_ONE');

-- CreateTable
CREATE TABLE "semantic_models" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "SemanticModelStatus" NOT NULL DEFAULT 'DRAFT',
    "has_draft_changes" BOOLEAN NOT NULL DEFAULT true,
    "validation_status" "SemanticValidationStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "validation_report" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "published_snapshot" JSONB,
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_entities" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dataset_id" UUID NOT NULL,
    "primary_key" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_dimensions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "DimensionType" NOT NULL,
    "expr" TEXT NOT NULL,
    "granularities" TEXT[],
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_dimensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_measures" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agg" TEXT NOT NULL,
    "expr" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_measures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semantic_relationships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "semantic_model_id" UUID NOT NULL,
    "from_entity_id" UUID NOT NULL,
    "to_entity_id" UUID NOT NULL,
    "join_columns" JSONB NOT NULL,
    "cardinality" "RelationshipCardinality" NOT NULL,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "semantic_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "semantic_models_organization_id_id_key" ON "semantic_models"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_models_organization_id_key_key" ON "semantic_models"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_entities_organization_id_id_key" ON "semantic_entities"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_entities_semantic_model_id_key_key" ON "semantic_entities"("semantic_model_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_dimensions_organization_id_id_key" ON "semantic_dimensions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_dimensions_entity_id_key_key" ON "semantic_dimensions"("entity_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_measures_organization_id_id_key" ON "semantic_measures"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_measures_entity_id_key_key" ON "semantic_measures"("entity_id", "key");

-- CreateIndex
CREATE INDEX "semantic_relationships_semantic_model_id_idx" ON "semantic_relationships"("semantic_model_id");

-- CreateIndex
CREATE UNIQUE INDEX "semantic_relationships_organization_id_id_key" ON "semantic_relationships"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "semantic_models" ADD CONSTRAINT "semantic_models_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_entities" ADD CONSTRAINT "semantic_entities_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_entities" ADD CONSTRAINT "semantic_entities_organization_id_dataset_id_fkey" FOREIGN KEY ("organization_id", "dataset_id") REFERENCES "datasets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_dimensions" ADD CONSTRAINT "semantic_dimensions_organization_id_entity_id_fkey" FOREIGN KEY ("organization_id", "entity_id") REFERENCES "semantic_entities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_measures" ADD CONSTRAINT "semantic_measures_organization_id_entity_id_fkey" FOREIGN KEY ("organization_id", "entity_id") REFERENCES "semantic_entities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_relationships" ADD CONSTRAINT "semantic_relationships_organization_id_semantic_model_id_fkey" FOREIGN KEY ("organization_id", "semantic_model_id") REFERENCES "semantic_models"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_relationships" ADD CONSTRAINT "semantic_relationships_organization_id_from_entity_id_fkey" FOREIGN KEY ("organization_id", "from_entity_id") REFERENCES "semantic_entities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semantic_relationships" ADD CONSTRAINT "semantic_relationships_organization_id_to_entity_id_fkey" FOREIGN KEY ("organization_id", "to_entity_id") REFERENCES "semantic_entities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Keys are the names used by the Semantic Query IR.
ALTER TABLE app.semantic_models ADD CONSTRAINT semantic_models_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE app.semantic_entities ADD CONSTRAINT semantic_entities_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE app.semantic_dimensions ADD CONSTRAINT semantic_dimensions_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE app.semantic_measures ADD CONSTRAINT semantic_measures_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE app.semantic_measures ADD CONSTRAINT semantic_measures_agg CHECK (agg IN ('sum', 'count', 'count_distinct', 'avg', 'min', 'max'));
ALTER TABLE app.semantic_relationships ADD CONSTRAINT semantic_relationships_distinct_entities CHECK (from_entity_id <> to_entity_id);

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['semantic_models', 'semantic_entities', 'semantic_dimensions', 'semantic_measures', 'semantic_relationships']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I
         USING (organization_id = app.ctx_uuid(''app.org_id''))
         WITH CHECK (organization_id = app.ctx_uuid(''app.org_id''))', t);
  END LOOP;
END $$;
