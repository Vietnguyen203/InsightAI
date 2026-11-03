-- Phase 2a: identity, tenancy and audit. Generated DDL (prisma migrate diff) followed by
-- hand-written RLS policies, grants and reference data. See docs/DATABASE_DESIGN.md §4.


-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "data_schema" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'PROVISIONING',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "locale" TEXT NOT NULL DEFAULT 'vi',
    "default_currency" TEXT NOT NULL DEFAULT 'VND',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_code")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by" UUID,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_by" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "changes" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_data_schema_key" ON "organizations"("data_schema");

-- CreateIndex
CREATE INDEX "roles_organization_id_idx" ON "roles"("organization_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_created_at_idx" ON "invitations"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permissions"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- Reference data: permissions and system roles. Must match packages/contracts/src/iam.ts
-- (verified by test/iam-seed.int.test.ts).
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO app.permissions (code, description) VALUES
  ('org:read', 'View organization settings'),
  ('org:update', 'Change organization settings'),
  ('member:read', 'View members'),
  ('member:manage', 'Change member roles and remove members'),
  ('invitation:manage', 'Create and revoke invitation links'),
  ('audit:read', 'View the audit log'),
  ('dataset:read', 'View datasets'),
  ('dataset:write', 'Upload, import and manage datasets'),
  ('quality:read', 'View data quality reports'),
  ('quality:write', 'Manage data quality rules and run checks'),
  ('quality:apply_cleaning', 'Apply cleaning operations (creates new dataset versions)'),
  ('semantic:read', 'View semantic models and metrics'),
  ('semantic:write', 'Edit semantic models and draft metrics'),
  ('semantic:publish', 'Publish semantic models and metric versions'),
  ('semantic:query', 'Query metrics and ask questions'),
  ('dashboard:read', 'View dashboards'),
  ('dashboard:write', 'Create and edit dashboards');

INSERT INTO app.roles (id, organization_id, key, name, is_system) VALUES
  ('00000000-0000-7000-8000-000000000001', NULL, 'owner', 'Owner', true),
  ('00000000-0000-7000-8000-000000000002', NULL, 'admin', 'Admin', true),
  ('00000000-0000-7000-8000-000000000003', NULL, 'analyst', 'Analyst', true),
  ('00000000-0000-7000-8000-000000000004', NULL, 'viewer', 'Viewer', true);

CREATE UNIQUE INDEX roles_system_key_key ON app.roles (key) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX roles_org_key_key ON app.roles (organization_id, key) WHERE organization_id IS NOT NULL;

INSERT INTO app.role_permissions (role_id, permission_code)
SELECT '00000000-0000-7000-8000-000000000001'::uuid, code FROM app.permissions
UNION ALL
SELECT '00000000-0000-7000-8000-000000000002'::uuid, code FROM app.permissions
UNION ALL
SELECT '00000000-0000-7000-8000-000000000003'::uuid, unnest(ARRAY[
  'org:read', 'member:read', 'dataset:read', 'quality:read', 'semantic:read', 'semantic:query',
  'dashboard:read', 'dataset:write', 'quality:write', 'quality:apply_cleaning', 'semantic:write',
  'dashboard:write'])
UNION ALL
SELECT '00000000-0000-7000-8000-000000000004'::uuid, unnest(ARRAY[
  'org:read', 'member:read', 'dataset:read', 'quality:read', 'semantic:read', 'semantic:query',
  'dashboard:read']);

-- Seed rows are inserted before RLS is enabled: FORCE ROW LEVEL SECURITY also applies to the owner.

-- ═════════════════════════════════════════════════════════════════════════════
-- Request context helpers. The application sets these transaction-local settings
-- (PrismaService.runInContext); NULLIF is required because a setting reverts to ''
-- (not NULL) on a pooled connection after a transaction that used it.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION app.ctx_uuid(setting text) RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting(setting, true), '')::uuid $$;

CREATE FUNCTION app.ctx_text(setting text) RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting(setting, true), '') $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Row-Level Security. FORCE makes policies apply to the table owner as well.
-- Context keys: app.org_id, app.user_id, and three narrowly scoped lookup keys used
-- only before the caller is identified: app.login_email, app.refresh_token_hash,
-- app.invite_token_hash.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
-- A user sees themselves, members of the current organization, and the single account
-- matching the email being authenticated.
CREATE POLICY users_select ON app.users FOR SELECT USING (
  id = app.ctx_uuid('app.user_id')
  OR email = app.ctx_text('app.login_email')
  OR EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.user_id = users.id AND m.organization_id = app.ctx_uuid('app.org_id')
  )
);
CREATE POLICY users_insert ON app.users FOR INSERT WITH CHECK (id = app.ctx_uuid('app.user_id'));
CREATE POLICY users_update ON app.users FOR UPDATE
  USING (id = app.ctx_uuid('app.user_id'))
  WITH CHECK (id = app.ctx_uuid('app.user_id'));

ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_select ON app.organizations FOR SELECT USING (
  id = app.ctx_uuid('app.org_id')
  OR EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.organization_id = organizations.id AND m.user_id = app.ctx_uuid('app.user_id')
  )
);
CREATE POLICY organizations_insert ON app.organizations FOR INSERT
  WITH CHECK (id = app.ctx_uuid('app.org_id'));
CREATE POLICY organizations_update ON app.organizations FOR UPDATE
  USING (id = app.ctx_uuid('app.org_id'))
  WITH CHECK (id = app.ctx_uuid('app.org_id'));

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
-- Members of the current organization, plus the caller's own memberships in any organization
-- (needed to list "my organizations" and to resolve membership before entering a tenant).
CREATE POLICY memberships_select ON app.memberships FOR SELECT USING (
  organization_id = app.ctx_uuid('app.org_id') OR user_id = app.ctx_uuid('app.user_id')
);
CREATE POLICY memberships_insert ON app.memberships FOR INSERT
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id'));
CREATE POLICY memberships_update ON app.memberships FOR UPDATE
  USING (organization_id = app.ctx_uuid('app.org_id'))
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id'));
CREATE POLICY memberships_delete ON app.memberships FOR DELETE
  USING (organization_id = app.ctx_uuid('app.org_id'));

ALTER TABLE app.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON app.roles FOR SELECT USING (
  organization_id IS NULL OR organization_id = app.ctx_uuid('app.org_id')
);

ALTER TABLE app.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_select ON app.refresh_tokens FOR SELECT USING (
  user_id = app.ctx_uuid('app.user_id') OR token_hash = app.ctx_text('app.refresh_token_hash')
);
CREATE POLICY refresh_tokens_insert ON app.refresh_tokens FOR INSERT
  WITH CHECK (user_id = app.ctx_uuid('app.user_id'));
CREATE POLICY refresh_tokens_update ON app.refresh_tokens FOR UPDATE
  USING (user_id = app.ctx_uuid('app.user_id'))
  WITH CHECK (user_id = app.ctx_uuid('app.user_id'));

ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_select ON app.invitations FOR SELECT USING (
  organization_id = app.ctx_uuid('app.org_id') OR token_hash = app.ctx_text('app.invite_token_hash')
);
CREATE POLICY invitations_insert ON app.invitations FOR INSERT
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id'));
CREATE POLICY invitations_update ON app.invitations FOR UPDATE
  USING (organization_id = app.ctx_uuid('app.org_id'))
  WITH CHECK (organization_id = app.ctx_uuid('app.org_id'));

ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_select ON app.audit_logs FOR SELECT USING (
  organization_id = app.ctx_uuid('app.org_id')
);
-- Organization events must carry the current organization; user-level events (no organization)
-- may only be written for the current user.
CREATE POLICY audit_logs_insert ON app.audit_logs FOR INSERT WITH CHECK (
  organization_id IS NOT DISTINCT FROM app.ctx_uuid('app.org_id')
  AND (organization_id IS NOT NULL OR actor_user_id = app.ctx_uuid('app.user_id'))
);

-- permissions / role_permissions are global reference data: no RLS, read-only for the app.

-- ═════════════════════════════════════════════════════════════════════════════
-- Least privilege for the application role (default privileges grant full DML).
-- The role name is not hard-coded: it is whoever received default privileges from the owner.
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE app_role text;
BEGIN
  FOR app_role IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'app' AND table_name = 'users' AND privilege_type = 'INSERT'
      AND grantee <> current_user
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON app.roles, app.permissions, app.role_permissions FROM %I', app_role);
    EXECUTE format('REVOKE UPDATE, DELETE ON app.audit_logs FROM %I', app_role);
    EXECUTE format('REVOKE DELETE ON app.users, app.organizations, app.refresh_tokens, app.invitations FROM %I', app_role);
  END LOOP;
END $$;
