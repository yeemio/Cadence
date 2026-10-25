-- maintenance 模块四表（M3，m3-drafts/02-maintenance.md v1.0）。
--
-- 表形态分工（三域同表各归其位，ADR-0010）：
--   maintenance_plans      维保计划版本（版本化主数据，形态同 payroll_rules：
--                          (tenant, plan_id, object_version) 与 (tenant,
--                          supersedes) 唯一；plan_id = kebab 业务身份跨版本稳定；
--                          cycle JSONB = daily / interval-days；checkpoints JSONB =
--                          点检判据清单（判据是数据不是枚举）；upkeep_actions
--                          JSONB = 保养动作清单——修订=发新版本，历史记录溯源
--                          旧版可解释，合同 §3/§7）；
--   maintenance_tasks      维保任务投影行（状态机投影，形态同 fault_reports /
--                          inspections：state + object_version 随迁移条件更新
--                          （非事实表不套证据公共列）；flow_config_id = engine-flow
--                          配置换代防线；(tenant, source_key) 唯一 = plan-due
--                          任务到期锚点 due:<plan_id>:<occurrence_key>（due-scan
--                          幂等去重 DB 防线，对齐 overdue.scan 先例；manual/fault
--                          任务 source_key 空不参与唯一约束）；G2：建单先落
--                          scheduled@v1 投影再驱动迁移）；
--   maintenance_activities 三态记录（append-only 执行留痕事实，kind 判别三态
--                          checkpoint/upkeep/repair（草案形状保持）：checkpoint
--                          落 checkpoint_id+result；upkeep 落 actions_done JSONB；
--                          repair 落 fault_ref+restored；证据七公共列 TEXT 口径 +
--                          seq 游标；plan_version 快照 = 记录时点计划当前版本
--                          （溯源旧版可解释）；修正走冲销/补录不改原行）；
--   maintenance_operations 命令幂等记账（运营表，不套证据公共列）。
--
-- 域事件不建新表：落既有通用 event_records / outbox_records（PG 适配见
-- src/maintenance/pg-maintenance-stores.ts）。模块迁移占计划槽位 070000（早于
-- 已落库的 drawing 080000 / metric-pack 090000——按波次计划错峰，不影响全新库
-- 按名序应用；RLS 重放快照取最新序守恒，见 20261026110000）。

-- CreateTable：维保计划版本（版本化主数据）
CREATE TABLE "maintenance_plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "name" TEXT,
    "resource_ref" TEXT NOT NULL,
    "cycle" JSONB NOT NULL,
    "checkpoints" JSONB NOT NULL,
    "upkeep_actions" JSONB NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "supersedes" TEXT,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable：维保任务（状态机投影行）
CREATE TABLE "maintenance_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "flow_config_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resource_ref" TEXT NOT NULL,
    "fault_ref" TEXT,
    "plan_id" TEXT,
    "plan_version" INTEGER,
    "due_key" TEXT,
    "due_at" TIMESTAMPTZ(6),
    "assignee" TEXT,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "source_key" TEXT,

    CONSTRAINT "maintenance_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable：三态记录（append-only 执行留痕事实）
CREATE TABLE "maintenance_activities" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "resource_ref" TEXT NOT NULL,
    "plan_id" TEXT,
    "plan_version" INTEGER,
    "task_id" TEXT,
    "checkpoint_id" TEXT,
    "result" TEXT,
    "actions_done" JSONB,
    "fault_ref" TEXT,
    "restored" BOOLEAN,
    "performed_by" TEXT NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "audit_status" TEXT NOT NULL,
    "provenance" JSONB,
    "supersedes" TEXT,
    "business_time" TIMESTAMPTZ(6),
    "available_time" TIMESTAMPTZ(6),

    CONSTRAINT "maintenance_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账（运营表）
CREATE TABLE "maintenance_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command_kind" TEXT NOT NULL,

    CONSTRAINT "maintenance_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_plans_tenant_id_plan_id_object_version_key" ON "maintenance_plans"("tenant_id", "plan_id", "object_version");

CREATE UNIQUE INDEX "maintenance_plans_tenant_id_supersedes_key" ON "maintenance_plans"("tenant_id", "supersedes");

CREATE INDEX "maintenance_plans_tenant_id_plan_id_idx" ON "maintenance_plans"("tenant_id", "plan_id");

CREATE INDEX "maintenance_plans_tenant_id_resource_ref_idx" ON "maintenance_plans"("tenant_id", "resource_ref");

CREATE UNIQUE INDEX "maintenance_tasks_tenant_id_source_key_key" ON "maintenance_tasks"("tenant_id", "source_key");

CREATE INDEX "maintenance_tasks_tenant_id_state_idx" ON "maintenance_tasks"("tenant_id", "state");

CREATE INDEX "maintenance_tasks_tenant_id_resource_ref_idx" ON "maintenance_tasks"("tenant_id", "resource_ref");

CREATE INDEX "maintenance_tasks_tenant_id_assignee_idx" ON "maintenance_tasks"("tenant_id", "assignee");

CREATE INDEX "maintenance_tasks_tenant_id_plan_id_idx" ON "maintenance_tasks"("tenant_id", "plan_id");

CREATE INDEX "maintenance_activities_tenant_id_resource_ref_performed_at_seq_idx" ON "maintenance_activities"("tenant_id", "resource_ref", "performed_at" DESC, "seq" DESC);

CREATE INDEX "maintenance_activities_tenant_id_task_id_idx" ON "maintenance_activities"("tenant_id", "task_id");

CREATE UNIQUE INDEX "maintenance_operations_tenant_id_operation_id_key" ON "maintenance_operations"("tenant_id", "operation_id");

-- append-only 护栏（同 payroll/drawing 迁移口径）：计划版本/三态记录禁
-- UPDATE/DELETE（修订走新版本行；留痕修正走冲销/补录）；任务投影行随状态机
-- 迁移 UPDATE 豁免（行级条件更新）；幂等记账运营表豁免。
CREATE TRIGGER "maintenance_plans_append_only_guard"
  BEFORE UPDATE OR DELETE ON "maintenance_plans"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();

CREATE TRIGGER "maintenance_activities_append_only_guard"
  BEFORE UPDATE OR DELETE ON "maintenance_activities"
  FOR EACH ROW EXECUTE FUNCTION "business_store_forbid_mutation"();
