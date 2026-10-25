-- U1 issue 发料链路五表（A11 增量：发料任务/发料记录——发料任务派工自动生成
-- 维度、去发料/确认发料快照、撤销原路回滚、快递单元数据；库存/预占联动经
-- application IssueMaterialPort 端口注入，本表组不含库存表）。
--
-- 表形态分工（运营单据取舍，schema.prisma issue 节同文）：
--   issue_tasks            发料任务投影（状态 not-started/issuing/done 由汇总
--                          推导 refreshSummary 乐观推进；(tenant, dimension_key)
--                          唯一 = 工作令+派工类型+归拢+设备维——应用侧拼键，
--                          归拢行设备维空值收敛进唯一键）；
--   issue_task_lines       任务明细行投影（(tenant, task, source_line_id) 唯一 =
--                          派工同步补全幂等锚点；行号任务内续排）；
--   issue_records          发料记录投影（确认快照 + 撤销态：lines JSONB 含
--                          行快照/库位分配/扣减回执/issueKey 回滚锚点；撤销 =
--                          state 迁移 revoked——legacy is_deleted 语义，不删行）；
--   issue_expresses        快递单（发货头元数据：单号/发货人/发货时间/图片
--                          引用数组 ≤6——对象存储零依赖，只存引用串）；
--   issue_operations       命令幂等记账（PK = operation_key = 租户|operationId，
--                          运营表豁免触发器）。
--
-- 均不套证据公共列、不设 append-only 触发器（运营单据非不可变事实——不可变
-- 事实由域事件 event_records/outbox_records 承载，复用 M1 既有表）。
-- RLS 同批补登：src/rls/tables.ts 五行 + 全量重放迁移 20261026140100。

-- CreateTable：发料任务
CREATE TABLE "issue_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_no" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "work_order_label" TEXT,
    "dispatch_kind" TEXT NOT NULL,
    "rollup" BOOLEAN NOT NULL DEFAULT false,
    "equipment_ref" TEXT,
    "dimension_key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "planned_start_at" TIMESTAMPTZ(6),
    "planned_end_at" TIMESTAMPTZ(6),
    "operators" JSONB NOT NULL DEFAULT '[]',
    "trigger_refs" JSONB NOT NULL DEFAULT '[]',
    "total_required_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_issued_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable：任务明细行
CREATE TABLE "issue_task_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "source_line_id" TEXT NOT NULL,
    "item_id" TEXT,
    "module_name" TEXT,
    "name" TEXT,
    "drawing_no" TEXT,
    "required_qty" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issue_task_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable：发料记录
CREATE TABLE "issue_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "record_no" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_no" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "work_order_label" TEXT,
    "dispatch_kind" TEXT NOT NULL,
    "rollup" BOOLEAN NOT NULL DEFAULT false,
    "equipment_ref" TEXT,
    "line_kind" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "issued_by" TEXT NOT NULL,
    "total_qty" DOUBLE PRECISION NOT NULL,
    "express_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "lines" JSONB NOT NULL,
    "object_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable：快递单（发货头）
CREATE TABLE "issue_expresses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tracking_no" TEXT NOT NULL,
    "shipper" TEXT NOT NULL,
    "ship_time" TIMESTAMPTZ(6) NOT NULL,
    "image_refs" JSONB NOT NULL DEFAULT '[]',
    "work_order_id" TEXT,
    "task_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_expresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable：命令幂等记账
CREATE TABLE "issue_operations" (
    "operation_key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_operations_pkey" PRIMARY KEY ("operation_key")
);

-- CreateIndex：发料任务
CREATE UNIQUE INDEX "issue_tasks_tenant_id_dimension_key_key" ON "issue_tasks"("tenant_id", "dimension_key");

CREATE INDEX "issue_tasks_tenant_id_state_idx" ON "issue_tasks"("tenant_id", "state");

CREATE INDEX "issue_tasks_tenant_id_work_order_id_idx" ON "issue_tasks"("tenant_id", "work_order_id");

-- CreateIndex：任务明细行
CREATE UNIQUE INDEX "issue_task_lines_tenant_id_task_id_source_line_id_key" ON "issue_task_lines"("tenant_id", "task_id", "source_line_id");

CREATE INDEX "issue_task_lines_tenant_id_task_id_idx" ON "issue_task_lines"("tenant_id", "task_id");

CREATE INDEX "issue_task_lines_tenant_id_source_line_id_idx" ON "issue_task_lines"("tenant_id", "source_line_id");

-- CreateIndex：发料记录
CREATE INDEX "issue_records_tenant_id_task_id_idx" ON "issue_records"("tenant_id", "task_id");

CREATE INDEX "issue_records_tenant_id_work_order_id_idx" ON "issue_records"("tenant_id", "work_order_id");

CREATE INDEX "issue_records_tenant_id_issued_at_idx" ON "issue_records"("tenant_id", "issued_at" DESC);

-- CreateIndex：快递单
CREATE INDEX "issue_expresses_tenant_id_work_order_id_tracking_no_idx" ON "issue_expresses"("tenant_id", "work_order_id", "tracking_no");

CREATE INDEX "issue_expresses_tenant_id_task_id_idx" ON "issue_expresses"("tenant_id", "task_id");

-- CreateIndex：命令幂等记账
CREATE INDEX "issue_operations_tenant_id_idx" ON "issue_operations"("tenant_id");
