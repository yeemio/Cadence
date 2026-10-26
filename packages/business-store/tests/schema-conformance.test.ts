/**
 * schema 一致性测试（不依赖活库 / prisma generate）：
 * 机器校验 prisma/schema.prisma 与 evidence-columns.v1 合同、business-core
 * 形状（BusinessEvent / OutboxRecord）、ADR-0005 全表 tenant_id 的一致性。
 *
 * 证据公共列的复用模式 = "约定字段块 + 本测试守恒"：Prisma 无 mixin，
 * 漏列 / 改型 / 掉 tenant_id / 掉 append-only 触发器，都在这里变红。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaText = readFileSync(join(packageRoot, 'prisma', 'schema.prisma'), 'utf8');

interface ParsedField {
  name: string;
  /** 声明类型原文（含 ?，如 "String?" / "DateTime?"） */
  type: string;
  /** 该行全部属性原文（@id / @map(...) / @default(...) / @relation(...) …） */
  attrs: string;
}
interface ParsedModel {
  name: string;
  fields: Map<string, ParsedField>;
  /** 块级属性（@@index / @@unique / @@map …）原文 */
  blockAttrs: string[];
}

function parseModels(source: string): Map<string, ParsedModel> {
  const models = new Map<string, ParsedModel>();
  const modelPattern = /^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = modelPattern.exec(source)) !== null) {
    const model: ParsedModel = { name: match[1]!, fields: new Map(), blockAttrs: [] };
    for (const line of match[2]!.split('\n')) {
      const fieldMatch = /^\s+(\w+)\s+([^\s]+)((?:\s+@.*)*)$/.exec(line);
      if (fieldMatch) {
        model.fields.set(fieldMatch[1]!, {
          name: fieldMatch[1]!,
          type: fieldMatch[2]!,
          attrs: fieldMatch[3]!.trim(),
        });
        continue;
      }
      const blockMatch = /^\s+(@@\w+.*)$/.exec(line);
      if (blockMatch) model.blockAttrs.push(blockMatch[1]!.trim());
    }
    models.set(model.name, model);
  }
  return models;
}

const models = parseModels(schemaText);

function field(modelName: string, fieldName: string): ParsedField {
  const model = models.get(modelName);
  expect(model, `model ${modelName} 应存在`).toBeDefined();
  const f = model?.fields.get(fieldName);
  expect(f, `${modelName}.${fieldName} 应存在`).toBeDefined();
  return f!;
}

function expectField(modelName: string, fieldName: string, type: string, attrSubstrings: string[]): void {
  const f = field(modelName, fieldName);
  expect(f.type, `${modelName}.${fieldName} 类型`).toBe(type);
  for (const attr of attrSubstrings) {
    expect(f.attrs.includes(attr), `${modelName}.${fieldName} 含 ${attr}`).toBe(true);
  }
}

/** 落地证据标准公共列的事实表清单——新增事实表往此加，即受同一守恒校验。 */
const EVIDENCE_FACT_MODELS = ['WorkOrderRecord', 'ProcessDefRecord', 'EquipmentRecord', 'OutsourcingPriceRuleRecord', 'MaterialValidationRunRecord', 'RoutingRecord', 'StandardTimeRecord'] as const;

function expectEvidenceBlock(modelName: string): void {
  expectField(modelName, 'id', 'String', ['@id', '@default(uuid(7))', '@db.Uuid']);
  expectField(modelName, 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
  expectField(modelName, 'auditStatus', 'String', ['@map("audit_status")']);
  expectField(modelName, 'provenance', 'Json?', ['@map("provenance")']);
  expectField(modelName, 'supersedes', 'String?', ['@db.Uuid', '@map("supersedes")']);
  expectField(modelName, 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
  expectField(modelName, 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
}

describe('schema 骨架', () => {
  it('PG 方言 + client generator', () => {
    expect(schemaText).toMatch(/provider\s*=\s*"postgresql"/);
    expect(schemaText).toMatch(/generator\s+client\s*\{/);
  });

  it('一百零二张表齐全（M1 十三表 + baseline P1 五表（M2-W2）+ workorder 六表（M2-W1）+ inspection 四表（M2-W4）+ listing 八表（M2-W3）+ dispatch 四表（M2-W6）+ inventory 十一表（M2-W5）+ reporting 四表（M2-W7）+ baseline P2/P3 四表（M2-W7）+ hours 三表（M2-W6）+ costing 四表（M2-W6）+ payroll 四表（M3）+ metric-pack 两表（M3）+ drawing 四表（M3）+ maintenance 四表（M3）+ backfill 六表（S1）+ S5 能力子集三表（T 波）+ issue 五表（U1）+ attachment 单表（U3）+ process-material 单表（U4）+ aftercare claim 两表（U5）+ project cost 三表（U7）+ attachment objects 单表（fix-wave-4 W4-2））', () => {
    expect(models.has('WorkOrderRecord')).toBe(true);
    expect(models.has('BusinessEventRecord')).toBe(true);
    expect(models.has('OutboxRecord')).toBe(true);
    expect(models.has('UserRecord')).toBe(true);
    expect(models.has('RoleRecord')).toBe(true);
    expect(models.has('PolicyRecord')).toBe(true);
    expect(models.has('SessionRecord')).toBe(true);
    expect(models.has('ItemRecord')).toBe(true);
    expect(models.has('ResourceRecord')).toBe(true);
    expect(models.has('TodoRecord')).toBe(true);
    expect(models.has('ApprovalCaseRecord')).toBe(true);
    expect(models.has('ApprovalDecisionRecord')).toBe(true);
    expect(models.has('ApprovalEventRecord')).toBe(true);
    expect(models.has('ProcessDefRecord')).toBe(true);
    expect(models.has('EquipmentRecord')).toBe(true);
    expect(models.has('OutsourcingPriceRuleRecord')).toBe(true);
    expect(models.has('MaterialValidationRunRecord')).toBe(true);
    expect(models.has('BaselineOperationRecord')).toBe(true);
    expect(models.has('WorkOrderProjectionRecord')).toBe(true);
    expect(models.has('PartsRequestRecord')).toBe(true);
    expect(models.has('WorkorderEventRecord')).toBe(true);
    expect(models.has('WorkOrderAttachmentRecord')).toBe(true);
    expect(models.has('KitCheckRecord')).toBe(true);
    expect(models.has('WorkorderOperationRecord')).toBe(true);
    expect(models.has('InspectionOrderRecord')).toBe(true);
    expect(models.has('NonconformRecord')).toBe(true);
    expect(models.has('InspectionEventRecord')).toBe(true);
    expect(models.has('InspectionOperationRecord')).toBe(true);
    expect(models.has('ListingSheetRecord')).toBe(true);
    expect(models.has('ListingLineRecord')).toBe(true);
    expect(models.has('GapCheckRecord')).toBe(true);
    expect(models.has('PurchaseRequestRecord')).toBe(true);
    expect(models.has('PurchaseOrderRecord')).toBe(true);
    expect(models.has('PurchaseReturnRecord')).toBe(true);
    expect(models.has('ListingEventRecord')).toBe(true);
    expect(models.has('ListingOperationRecord')).toBe(true);
    expect(models.has('DispatchOrderRecord')).toBe(true);
    expect(models.has('OutsourcingLineRecord')).toBe(true);
    expect(models.has('DispatchEventRecord')).toBe(true);
    expect(models.has('DispatchOperationRecord')).toBe(true);
    expect(models.has('WarehouseRecord')).toBe(true);
    expect(models.has('WarehouseLocationRecord')).toBe(true);
    expect(models.has('StockAccountRecord')).toBe(true);
    expect(models.has('StockLocationBalanceRecord')).toBe(true);
    expect(models.has('StockMovementRecord')).toBe(true);
    expect(models.has('StockReservationRecord')).toBe(true);
    expect(models.has('StocktakeRecord')).toBe(true);
    expect(models.has('ShippingOrderRecord')).toBe(true);
    expect(models.has('InventoryEventRecord')).toBe(true);
    expect(models.has('InventoryOperationRecord')).toBe(true);
    expect(models.has('ReleaseFactRecord')).toBe(true);
    // M2-W7 reporting 四表（守恒计数 51 → 55）
    expect(models.has('WorkReportRecord')).toBe(true);
    expect(models.has('ReportAuditRecord')).toBe(true);
    expect(models.has('ReportingEventRecord')).toBe(true);
    expect(models.has('ReportingOperationRecord')).toBe(true);
    // M2-W7 baseline P2/P3 四表（守恒计数 55 → 59；hours/costing 并行线建表后另行递增）
    expect(models.has('RoutingRecord')).toBe(true);
    expect(models.has('StandardTimeRecord')).toBe(true);
    expect(models.has('FaultReportRecord')).toBe(true);
    expect(models.has('FaultEventRecord')).toBe(true);
    // M2-W6 hours 三表（守恒计数 59 → 62）
    expect(models.has('LaborEntryRecord')).toBe(true);
    expect(models.has('LaborLedgerMonthRecord')).toBe(true);
    expect(models.has('HoursOperationRecord')).toBe(true);
    // M2-W6 costing 四表（守恒计数 62 → 66）
    expect(models.has('CostEntryRecord')).toBe(true);
    expect(models.has('CostingModelRecord')).toBe(true);
    expect(models.has('CostSnapshotRecord')).toBe(true);
    expect(models.has('CostingOperationRecord')).toBe(true);
    // M3 payroll 四表（守恒计数 66 → 70，m3-drafts/01-payroll.md v1.0）
    expect(models.has('PayrollRuleRecord')).toBe(true);
    expect(models.has('PayRunRecord')).toBe(true);
    expect(models.has('EarningsRecordRecord')).toBe(true);
    expect(models.has('PayrollOperationRecord')).toBe(true);
    // M3 metric-pack 两表（守恒计数 70 → 72，m3-drafts/04-metric-pack.md v1.0）
    expect(models.has('MetricPackActivationRecord')).toBe(true);
    expect(models.has('MetricPackOperationRecord')).toBe(true);
    // M3 drawing 四表（守恒计数 72 → 76，m3-drafts/03-drawing.md v1.0）
    expect(models.has('DrawingRevisionRecord')).toBe(true);
    expect(models.has('DrawingChangeNoticeRecord')).toBe(true);
    expect(models.has('DrawingViewTrailRecord')).toBe(true);
    expect(models.has('DrawingOperationRecord')).toBe(true);
    // M3 maintenance 四表（守恒计数 76 → 80，m3-drafts/02-maintenance.md v1.0）
    expect(models.has('MaintenancePlanRecord')).toBe(true);
    expect(models.has('MaintenanceTaskRecord')).toBe(true);
    expect(models.has('MaintenanceActivityRecord')).toBe(true);
    expect(models.has('MaintenanceOperationRecord')).toBe(true);
    // S1 backfill 六表（守恒计数 80 → 86，0920 #3/#7/#8/#9/#100/#103）
    expect(models.has('DepartmentRecord')).toBe(true);
    expect(models.has('PositionRecord')).toBe(true);
    expect(models.has('CustomerRecord')).toBe(true);
    expect(models.has('SupplierRecord')).toBe(true);
    expect(models.has('UnitRecord')).toBe(true);
    expect(models.has('AuditLogRecord')).toBe(true);
    // T 波 S5 能力子集三表（守恒计数 86 → 89，#98/99 菜单 / #102 审批配置 / #101 通知）
    expect(models.has('MenuConfigRecord')).toBe(true);
    expect(models.has('ApprovalFlowConfigRecord')).toBe(true);
    expect(models.has('NotificationRecord')).toBe(true);
    // U1 issue 发料链路五表（守恒计数 89 → 94，A11 增量：发料任务/发料记录）
    expect(models.has('IssueTaskRecord')).toBe(true);
    expect(models.has('IssueTaskLineRecord')).toBe(true);
    expect(models.has('IssueRecordRecord')).toBe(true);
    expect(models.has('IssueExpressRecord')).toBe(true);
    expect(models.has('IssueOperationRecord')).toBe(true);
    // U3 attachment 附件中心单表（守恒计数 94 → 95，A13 增量：统一附件元数据）
    expect(models.has('AttachmentRecord')).toBe(true);
    // U4 listing 工序×原材料关联单表（守恒计数 95 → 96，S10 数据面增量）
    expect(models.has('ProcessMaterialLinkRecord')).toBe(true);
    // U5 aftercare claim 售后报销两表（守恒计数 96 → 98，A12 增量：一单一投影 + 明细行）
    expect(models.has('AftercareClaimRecord')).toBe(true);
    expect(models.has('AftercareClaimLineRecord')).toBe(true);
    // U7 项目成本六块三表（守恒计数 98 → 101，A5 增量：段事实 + 六块快照 + 录入价格）
    expect(models.has('CostProjectEntryRecord')).toBe(true);
    expect(models.has('CostProjectSnapshotRecord')).toBe(true);
    expect(models.has('CostPriceEntryRecord')).toBe(true);
    // fix-wave-4 W4-2 attachment objects 单表（守恒计数 101 → 102，D-3 增量：对象字节 bytea）
    expect(models.has('AttachmentObjectRecord')).toBe(true);
    expect(models.size).toBe(102);
  });

  it('ADR-0005：全表 tenant_id（非空、snake_case 映射）', () => {
    for (const model of models.values()) {
      expectField(model.name, 'tenantId', 'String', ['@map("tenant_id")']);
    }
  });
});

describe('证据标准公共列（evidence-columns.v1）', () => {
  it.each(EVIDENCE_FACT_MODELS)('%s 完整落地证据公共列', (modelName) => {
    expectEvidenceBlock(modelName);
  });

  it('WorkOrderRecord：领域键 + 修正链完整性（同租户自引用 + 线性链）', () => {
    expectField('WorkOrderRecord', 'workOrderId', 'String', ['@map("work_order_id")', '@db.Uuid']);
    const predecessor = field('WorkOrderRecord', 'predecessor');
    expect(predecessor.attrs).toContain('fields: [supersedes, tenantId]');
    expect(predecessor.attrs).toContain('references: [id, tenantId]');
    const blockAttrs = models.get('WorkOrderRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([id, tenantId])');
    expect(blockAttrs).toContain('@@unique([tenantId, supersedes])');
    expect(blockAttrs).toContain('@@index([tenantId, workOrderId])');
    expect(blockAttrs).toContain('@@map("work_order_records")');
  });
});

describe('事件表（BusinessEvent 载荷）', () => {
  it('列面覆盖 BusinessEvent 全字段（aggregate 扁平化 + eventId 自然主键）', () => {
    expectField('BusinessEventRecord', 'eventId', 'String', ['@id', '@map("event_id")']);
    expectField('BusinessEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('BusinessEventRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('BusinessEventRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('BusinessEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    expectField('BusinessEventRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('BusinessEventRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)']);
    expectField('BusinessEventRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)']);
    expectField('BusinessEventRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('BusinessEventRecord', 'payload', 'Json', ['@map("payload")']);
    const blockAttrs = models.get('BusinessEventRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, occurredAt])');
    expect(blockAttrs).toContain('@@index([tenantId, aggregateId, aggregateRevision])');
    expect(blockAttrs).toContain('@@map("event_records")');
  });
});

describe('Outbox（OutboxRecord 形状 + tenant_id）', () => {
  it('列面覆盖 OutboxRecord 全字段，event 外键指向事件表', () => {
    expectField('OutboxRecord', 'eventId', 'String', ['@id', '@map("event_id")']);
    expectField('OutboxRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    expectField('OutboxRecord', 'attempts', 'Int', ['@default(0)', '@map("attempts")']);
    expectField('OutboxRecord', 'lastAttemptAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("last_attempt_at")']);
    expectField('OutboxRecord', 'nextAttemptAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("next_attempt_at")']);
    expectField('OutboxRecord', 'deliveredAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("delivered_at")']);
    const relation = field('OutboxRecord', 'event');
    expect(relation.attrs).toContain('fields: [eventId]');
    expect(relation.attrs).toContain('references: [eventId]');
    expect(models.get('OutboxRecord')!.blockAttrs.join('\n')).toContain('@@map("outbox_records")');
  });
});

describe('组织配置表（M1 增量 3-D：users/roles/policies，配置数据非事实表）', () => {
  it('users：契约列 + 租户内 username 唯一 + 文本主键（种子/mock 身份可用稳定非 uuid id）', () => {
    expectField('UserRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('UserRecord', 'username', 'String', []);
    expectField('UserRecord', 'displayName', 'String', ['@map("display_name")']);
    expectField('UserRecord', 'active', 'Boolean', ['@default(true)']);
    expectField('UserRecord', 'passwordHash', 'String?', ['@map("password_hash")']);
    const blockAttrs = models.get('UserRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([tenantId, username])');
    expect(blockAttrs).toContain('@@map("users")');
    // 配置表纪律：不套证据公共列
    expect(models.get('UserRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('UserRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('sessions：token 摘要唯一（明文 token 不落库）+ 撤销列 + 停用撤销索引；不设外键', () => {
    expectField('SessionRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('SessionRecord', 'userId', 'String', ['@map("user_id")']);
    expectField('SessionRecord', 'tokenDigest', 'String', ['@unique', '@map("token_digest")']);
    expectField('SessionRecord', 'createdAt', 'DateTime', ['@db.Timestamptz(6)', '@map("created_at")']);
    expectField('SessionRecord', 'expiresAt', 'DateTime', ['@db.Timestamptz(6)', '@map("expires_at")']);
    expectField('SessionRecord', 'refreshExpiresAt', 'DateTime', ['@db.Timestamptz(6)', '@map("refresh_expires_at")']);
    expectField('SessionRecord', 'revokedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("revoked_at")']);
    const blockAttrs = models.get('SessionRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, userId])');
    expect(blockAttrs).toContain('@@map("sessions")');
    expect(blockAttrs).not.toContain('@relation');
    // 运营状态纪律：不套证据公共列
    expect(models.get('SessionRecord')!.fields.has('objectVersion')).toBe(false);
  });

  it('roles：元数据列 + 租户内角色名唯一', () => {
    expectField('RoleRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('RoleRecord', 'name', 'String', []);
    expectField('RoleRecord', 'displayName', 'String', ['@map("display_name")']);
    const blockAttrs = models.get('RoleRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([tenantId, name])');
    expect(blockAttrs).toContain('@@map("roles")');
  });

  it('policies：rule_key 自然主键（幂等锚）+ PolicyRule 段列 + 无组织表外键', () => {
    expectField('PolicyRecord', 'ruleKey', 'String', ['@id', '@map("rule_key")']);
    expectField('PolicyRecord', 'kind', 'String', []);
    expectField('PolicyRecord', 'userId', 'String?', ['@map("user_id")']);
    expectField('PolicyRecord', 'role', 'String?', []);
    expectField('PolicyRecord', 'resource', 'String?', []);
    expectField('PolicyRecord', 'action', 'String?', []);
    const blockAttrs = models.get('PolicyRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId])');
    expect(blockAttrs).toContain('@@map("policies")');
    expect(blockAttrs).not.toContain('@relation');
  });
});

describe('基础数据表（M1 增量 4-I：items/resources，配置数据非事实表）', () => {
  it('items：契约列 + 租户内 code 唯一；不套证据公共列', () => {
    expectField('ItemRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('ItemRecord', 'code', 'String', []);
    expectField('ItemRecord', 'name', 'String', []);
    expectField('ItemRecord', 'spec', 'String?', []);
    expectField('ItemRecord', 'unit', 'String?', []);
    expectField('ItemRecord', 'category', 'String?', []);
    expectField('ItemRecord', 'active', 'Boolean', ['@default(true)']);
    expectField('ItemRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const blockAttrs = models.get('ItemRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([tenantId, code])');
    expect(blockAttrs).toContain('@@map("items")');
    expect(models.get('ItemRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('ItemRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('resources：契约列 + 租户内 code 唯一；不套证据公共列', () => {
    expectField('ResourceRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('ResourceRecord', 'code', 'String', []);
    expectField('ResourceRecord', 'name', 'String', []);
    expectField('ResourceRecord', 'type', 'String?', []);
    expectField('ResourceRecord', 'active', 'Boolean', ['@default(true)']);
    expectField('ResourceRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const blockAttrs = models.get('ResourceRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([tenantId, code])');
    expect(blockAttrs).toContain('@@map("resources")');
    expect(models.get('ResourceRecord')!.fields.has('objectVersion')).toBe(false);
  });

  it('todos：数据级过滤索引 (tenant_id, assignee_id, status) + 状态默认 open', () => {
    expectField('TodoRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('TodoRecord', 'assigneeId', 'String', ['@map("assignee_id")']);
    expectField('TodoRecord', 'title', 'String', []);
    expectField('TodoRecord', 'source', 'String', []);
    expectField('TodoRecord', 'refType', 'String?', ['@map("ref_type")']);
    expectField('TodoRecord', 'refId', 'String?', ['@map("ref_id")']);
    expectField('TodoRecord', 'status', 'String', ['@default("open")']);
    expectField('TodoRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    expectField('TodoRecord', 'dueAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("due_at")']);
    const blockAttrs = models.get('TodoRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, assigneeId, status])');
    expect(blockAttrs).toContain('@@map("todos")');
    expect(models.get('TodoRecord')!.fields.has('objectVersion')).toBe(false);
  });
});

describe('审批表（M1 收尾波-①：案件投影行 + 决策记录/迁移事件 append-only 账本）', () => {
  it('approval_cases：契约列 + 投影行（非事实表，不套证据公共列）', () => {
    expectField('ApprovalCaseRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('ApprovalCaseRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('ApprovalCaseRecord', 'state', 'String', []);
    expectField('ApprovalCaseRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('ApprovalCaseRecord', 'subjectType', 'String', ['@map("subject_type")']);
    expectField('ApprovalCaseRecord', 'subjectId', 'String', ['@map("subject_id")']);
    expectField('ApprovalCaseRecord', 'submitterId', 'String', ['@map("submitter_id")']);
    expectField('ApprovalCaseRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const blockAttrs = models.get('ApprovalCaseRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, state])');
    expect(blockAttrs).toContain('@@map("approval_cases")');
    // 投影行纪律：不套证据公共列
    expect(models.get('ApprovalCaseRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('approval_records：决策记录全字段（engine ApprovalRecord 形状扁平化）', () => {
    expectField('ApprovalDecisionRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('ApprovalDecisionRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('ApprovalDecisionRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('ApprovalDecisionRecord', 'reviewerId', 'String', ['@map("reviewer_id")']);
    expectField('ApprovalDecisionRecord', 'decision', 'String', []);
    expectField('ApprovalDecisionRecord', 'reason', 'String', []);
    expectField('ApprovalDecisionRecord', 'evidence', 'Json', []);
    expectField('ApprovalDecisionRecord', 'objectVersion', 'Int', ['@map("object_version")']);
    expectField('ApprovalDecisionRecord', 'decidedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("decided_at")']);
    const blockAttrs = models.get('ApprovalDecisionRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, aggregateId])');
    expect(blockAttrs).toContain('@@map("approval_records")');
  });

  it('approval_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁', () => {
    expectField('ApprovalEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('ApprovalEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('ApprovalEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('ApprovalEventRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('ApprovalEventRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('ApprovalEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    expectField('ApprovalEventRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('ApprovalEventRecord', 'payload', 'Json', ['@map("payload")']);
    const blockAttrs = models.get('ApprovalEventRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(blockAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(blockAttrs).toContain('@@map("approval_events")');
  });
});

describe('baseline P1 表（M2-W2：版本化主数据三表 + 校验运行事实表 + 幂等账本运营表）', () => {
  it('版本化主数据三表：证据公共列 + 同租户自引用修正链 + 版本唯一（并发竞态防线）', () => {
    for (const modelName of ['ProcessDefRecord', 'EquipmentRecord', 'OutsourcingPriceRuleRecord'] as const) {
      const predecessor = field(modelName, 'predecessor');
      expect(predecessor.attrs).toContain('fields: [supersedes, tenantId]');
      expect(predecessor.attrs).toContain('references: [id, tenantId]');
      const blockAttrs = models.get(modelName)!.blockAttrs.join('\n');
      expect(blockAttrs).toContain('@@unique([id, tenantId])');
      expect(blockAttrs).toContain('@@unique([tenantId, supersedes])');
      expect(blockAttrs).toContain('@@unique([tenantId, code, objectVersion])');
    }
    expectField('ProcessDefRecord', 'status', 'String', ['@default("active")']);
    expectField('OutsourcingPriceRuleRecord', 'processCode', 'String', ['@map("process_code")']);
    expectField('OutsourcingPriceRuleRecord', 'unitPriceMinor', 'Int', ['@map("unit_price_minor")']);
    expectField('OutsourcingPriceRuleRecord', 'marginPermyriad', 'Int', ['@map("margin_permyriad")']);
    expect(models.get('ProcessDefRecord')!.blockAttrs.join('\n')).toContain('@@map("process_defs")');
    expect(models.get('EquipmentRecord')!.blockAttrs.join('\n')).toContain('@@map("equipment_records")');
    expect(models.get('OutsourcingPriceRuleRecord')!.blockAttrs.join('\n')).toContain('@@map("outsourcing_price_rules")');
  });

  it('material_validation_runs：执行事实（载荷 JSONB + 证据公共列，无修正链唯一约束）', () => {
    expectField('MaterialValidationRunRecord', 'issuedBy', 'String', ['@map("issued_by")']);
    expectField('MaterialValidationRunRecord', 'summary', 'Json', ['@map("summary")']);
    expectField('MaterialValidationRunRecord', 'lines', 'Json', []);
    const blockAttrs = models.get('MaterialValidationRunRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId, createdAt])');
    expect(blockAttrs).toContain('@@map("material_validation_runs")');
    expect(blockAttrs).not.toContain('@@unique([tenantId, supersedes])'); // 无修正链
  });

  it('baseline_command_operations：幂等账本（运营表：不套证据公共列，租户内 operationId 唯一）', () => {
    expectField('BaselineOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('BaselineOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const blockAttrs = models.get('BaselineOperationRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([tenantId, operationId])');
    expect(blockAttrs).toContain('@@map("baseline_command_operations")');
    expect(models.get('BaselineOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('BaselineOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('baseline P2/P3 表（M2-W7：版本化主数据两表 + 故障投影行 + 状态机事件账本）', () => {
  it('routings / standard_times：P1 主数据同体例（证据公共列 + 同租户自引用修正链 + 版本唯一）', () => {
    for (const modelName of ['RoutingRecord', 'StandardTimeRecord'] as const) {
      const predecessor = field(modelName, 'predecessor');
      expect(predecessor.attrs).toContain('fields: [supersedes, tenantId]');
      expect(predecessor.attrs).toContain('references: [id, tenantId]');
      const blockAttrs = models.get(modelName)!.blockAttrs.join('\n');
      expect(blockAttrs).toContain('@@unique([id, tenantId])');
      expect(blockAttrs).toContain('@@unique([tenantId, supersedes])');
      expect(blockAttrs).toContain('@@unique([tenantId, code, objectVersion])');
    }
    expectField('RoutingRecord', 'steps', 'Json', []);
    expect(models.get('RoutingRecord')!.blockAttrs.join('\n')).toContain('@@map("routings")');
    expectField('StandardTimeRecord', 'scope', 'String', []);
    expectField('StandardTimeRecord', 'targetCode', 'String', ['@map("target_code")']);
    expectField('StandardTimeRecord', 'standardSeconds', 'Int', ['@map("standard_seconds")']);
    expectField('StandardTimeRecord', 'preparationSeconds', 'Int', ['@map("preparation_seconds")']);
    const stAttrs = models.get('StandardTimeRecord')!.blockAttrs.join('\n');
    expect(stAttrs).toContain('@@index([tenantId, scope, targetCode])');
    expect(stAttrs).toContain('@@map("standard_times")');
  });

  it('fault_reports：投影行（契约列 + 乐观版本；非事实表不套证据公共列）；fault_events：账本列面', () => {
    expectField('FaultReportRecord', 'id', 'String', ['@id']);
    expectField('FaultReportRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('FaultReportRecord', 'state', 'String', []);
    expectField('FaultReportRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('FaultReportRecord', 'equipmentCode', 'String', ['@map("equipment_code")']);
    const frAttrs = models.get('FaultReportRecord')!.blockAttrs.join('\n');
    expect(frAttrs).toContain('@@index([tenantId, state])');
    expect(frAttrs).toContain('@@map("fault_reports")');
    expect(models.get('FaultReportRecord')!.fields.has('objectVersion')).toBe(true);
    expect(models.get('FaultReportRecord')!.fields.has('supersedes')).toBe(false); // 投影行无修正链

    expectField('FaultEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('FaultEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('FaultEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    const feAttrs = models.get('FaultEventRecord')!.blockAttrs.join('\n');
    expect(feAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(feAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(feAttrs).toContain('@@map("fault_events")');
  });
});

describe('workorder 六表（M2-W1：投影两表 + 事件账本 + 事实两表 + 幂等记账）', () => {
  it('work_orders / parts_requests：投影行（契约列 + 乐观版本；非事实表不套证据公共列）', () => {
    expectField('WorkOrderProjectionRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('WorkOrderProjectionRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('WorkOrderProjectionRecord', 'state', 'String', []);
    expectField('WorkOrderProjectionRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('WorkOrderProjectionRecord', 'projectName', 'String', ['@map("project_name")']);
    expectField('WorkOrderProjectionRecord', 'manager', 'String?', ['@map("manager")']);
    const orderAttrs = models.get('WorkOrderProjectionRecord')!.blockAttrs.join('\n');
    expect(orderAttrs).toContain('@@index([tenantId, state])');
    expect(orderAttrs).toContain('@@index([tenantId, createdAt])');
    expect(orderAttrs).toContain('@@index([tenantId, manager])');
    expect(orderAttrs).toContain('@@map("work_orders")');
    expect(models.get('WorkOrderProjectionRecord')!.fields.has('supersedes')).toBe(false);

    expectField('PartsRequestRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('PartsRequestRecord', 'workOrderId', 'String', ['@map("work_order_id")']);
    expectField('PartsRequestRecord', 'objectVersion', 'Int', ['@default(2)', '@map("object_version")']);
    expectField('PartsRequestRecord', 'itemId', 'String', ['@map("item_id")']);
    expectField('PartsRequestRecord', 'quantity', 'Float', []);
    expectField('PartsRequestRecord', 'requester', 'String', []);
    expectField('PartsRequestRecord', 'shipmentRef', 'String?', ['@map("shipment_ref")']);
    const partsAttrs = models.get('PartsRequestRecord')!.blockAttrs.join('\n');
    expect(partsAttrs).toContain('@@index([tenantId, state])');
    expect(partsAttrs).toContain('@@index([tenantId, workOrderId])');
    expect(partsAttrs).toContain('@@map("parts_requests")');
    expect(models.get('PartsRequestRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('workorder_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 approval_events 形态）', () => {
    expectField('WorkorderEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('WorkorderEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('WorkorderEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('WorkorderEventRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('WorkorderEventRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('WorkorderEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    expectField('WorkorderEventRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('WorkorderEventRecord', 'payload', 'Json', ['@map("payload")']);
    const blockAttrs = models.get('WorkorderEventRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(blockAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(blockAttrs).toContain('@@map("workorder_events")');
  });

  it('work_order_attachments / kit_checks：业务事实，证据公共列齐全（TEXT 口径——id 为带前缀 uuidv7，非 @db.Uuid，见 schema 节注）', () => {
    for (const modelName of ['WorkOrderAttachmentRecord', 'KitCheckRecord'] as const) {
      // 证据字段块（evidence-columns.v1）——id/supersedes 落 TEXT（与迁移 DDL 一致），
      // 故不入 EVIDENCE_FACT_MODELS 的 @db.Uuid 榜单，在此按 TEXT 口径单独守恒。
      expectField(modelName, 'id', 'String', ['@id', '@default(uuid(7))']);
      expectField(modelName, 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
      expectField(modelName, 'auditStatus', 'String', ['@map("audit_status")']);
      expectField(modelName, 'provenance', 'Json?', ['@map("provenance")']);
      expectField(modelName, 'supersedes', 'String?', ['@map("supersedes")']);
      expectField(modelName, 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
      expectField(modelName, 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    }
    expectField('WorkOrderAttachmentRecord', 'workOrderId', 'String', ['@map("work_order_id")']);
    expectField('WorkOrderAttachmentRecord', 'attachedBy', 'String', ['@map("attached_by")']);
    expectField('WorkOrderAttachmentRecord', 'attachedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("attached_at")']);
    expect(models.get('WorkOrderAttachmentRecord')!.blockAttrs.join('\n')).toContain('@@map("work_order_attachments")');
    expect(models.get('WorkOrderAttachmentRecord')!.blockAttrs.join('\n')).toContain('@@index([tenantId, workOrderId])');

    expectField('KitCheckRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('KitCheckRecord', 'kinds', 'Json', []);
    expectField('KitCheckRecord', 'gapLines', 'Json', ['@map("gap_lines")']);
    expectField('KitCheckRecord', 'complete', 'Boolean', []);
    expectField('KitCheckRecord', 'refreshedBy', 'String', ['@map("refreshed_by")']);
    expectField('KitCheckRecord', 'refreshedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("refreshed_at")']);
    const kitAttrs = models.get('KitCheckRecord')!.blockAttrs.join('\n');
    expect(kitAttrs).toContain('@@index([tenantId, workOrderId, refreshedAt(sort: Desc), seq(sort: Desc)])');
    expect(kitAttrs).toContain('@@map("kit_checks")');
  });

  it('workorder_operations：幂等记账（operation_key 自然主键 = 租户|operationId；运营表不套证据公共列）', () => {
    expectField('WorkorderOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('WorkorderOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('WorkorderOperationRecord', 'command', 'String', []);
    expectField('WorkorderOperationRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('WorkorderOperationRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('WorkorderOperationRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    const blockAttrs = models.get('WorkorderOperationRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId])');
    expect(blockAttrs).toContain('@@map("workorder_operations")');
    expect(models.get('WorkorderOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('WorkorderOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('inspection 四表（M2-W4：投影两表 + 事件账本 + 幂等记账）', () => {
  it('inspections / nonconformities：投影行（契约列 + 乐观版本 + 判定/处置字段；非事实表不套证据公共列）', () => {
    expectField('InspectionOrderRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('InspectionOrderRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('InspectionOrderRecord', 'state', 'String', []);
    expectField('InspectionOrderRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('InspectionOrderRecord', 'kind', 'String', []);
    expectField('InspectionOrderRecord', 'sourceType', 'String?', ['@map("source_type")']);
    expectField('InspectionOrderRecord', 'sourceRefId', 'String?', ['@map("source_ref_id")']);
    expectField('InspectionOrderRecord', 'quantity', 'Float', []);
    expectField('InspectionOrderRecord', 'passedQty', 'Float?', ['@map("passed_qty")']);
    expectField('InspectionOrderRecord', 'failedQty', 'Float?', ['@map("failed_qty")']);
    expectField('InspectionOrderRecord', 'judgedBy', 'String?', ['@map("judged_by")']);
    expectField('InspectionOrderRecord', 'judgedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("judged_at")']);
    expectField('InspectionOrderRecord', 'closeDueAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("close_due_at")']);
    expectField('InspectionOrderRecord', 'overdueNotifiedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("overdue_notified_at")']);
    const orderAttrs = models.get('InspectionOrderRecord')!.blockAttrs.join('\n');
    expect(orderAttrs).toContain('@@unique([tenantId, sourceType, sourceRefId])'); // 来源幂等 DB 防线
    expect(orderAttrs).toContain('@@index([tenantId, kind, state])'); // 四类质检队列
    expect(orderAttrs).toContain('@@index([tenantId, state])');
    expect(orderAttrs).toContain('@@map("inspections")');
    expect(models.get('InspectionOrderRecord')!.fields.has('supersedes')).toBe(false);

    expectField('NonconformRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('NonconformRecord', 'inspectionId', 'String', ['@map("inspection_id")']);
    expectField('NonconformRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('NonconformRecord', 'quantity', 'Float', []);
    expectField('NonconformRecord', 'reason', 'String?', []);
    expectField('NonconformRecord', 'disposal', 'String?', []);
    expectField('NonconformRecord', 'disposeRemark', 'String?', ['@map("dispose_remark")']);
    expectField('NonconformRecord', 'disposedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("disposed_at")']);
    expectField('NonconformRecord', 'closedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("closed_at")']);
    const ncAttrs = models.get('NonconformRecord')!.blockAttrs.join('\n');
    expect(ncAttrs).toContain('@@index([tenantId, state])');
    expect(ncAttrs).toContain('@@index([tenantId, inspectionId])');
    expect(ncAttrs).toContain('@@map("nonconformities")');
    expect(models.get('NonconformRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('inspection_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 workorder_events 形态）', () => {
    expectField('InspectionEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('InspectionEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('InspectionEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('InspectionEventRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('InspectionEventRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('InspectionEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    expectField('InspectionEventRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('InspectionEventRecord', 'payload', 'Json', ['@map("payload")']);
    const blockAttrs = models.get('InspectionEventRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(blockAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(blockAttrs).toContain('@@map("inspection_events")');
  });

  it('inspection_operations：幂等记账（operation_key 自然主键 = 租户|operationId；运营表不套证据公共列）', () => {
    expectField('InspectionOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('InspectionOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('InspectionOperationRecord', 'command', 'String', []);
    expectField('InspectionOperationRecord', 'aggregateType', 'String', ['@map("aggregate_type")']);
    expectField('InspectionOperationRecord', 'aggregateId', 'String', ['@map("aggregate_id")']);
    expectField('InspectionOperationRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    const blockAttrs = models.get('InspectionOperationRecord')!.blockAttrs.join('\n');
    expect(blockAttrs).toContain('@@index([tenantId])');
    expect(blockAttrs).toContain('@@map("inspection_operations")');
    expect(models.get('InspectionOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('InspectionOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('append-only 触发器（若迁移已入库）', () => {  const migrationsDir = join(packageRoot, 'prisma', 'migrations');

  it('迁移 SQL：事实表与事件表有 UPDATE/DELETE 拒绝触发器，Outbox 明确豁免', () => {
    expect(existsSync(migrationsDir), 'migrations 目录应存在（done-when 4）').toBe(true);
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql') === false) // 目录
      .map((name) => join(migrationsDir, name, 'migration.sql'))
      .filter((path) => existsSync(path));
    // 直接列 migration.sql 文件（平铺或子目录两种约定都兼容）
    const sqlFiles = [
      ...files,
      ...readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => join(migrationsDir, name)),
    ];
    expect(sqlFiles.length).toBeGreaterThan(0);
    const sql = sqlFiles.map((path) => readFileSync(path, 'utf8')).join('\n');
    const triggerPattern = /CREATE TRIGGER\s+"?\w+"?\s+BEFORE UPDATE OR DELETE ON\s+"?(?:public\.)?(\w+)"?/g;
    const guarded = new Set<string>();
    for (const m of sql.matchAll(triggerPattern)) guarded.add(m[1]!);
    expect(guarded.has('work_order_records')).toBe(true);
    expect(guarded.has('event_records')).toBe(true);
    expect(guarded.has('outbox_records')).toBe(false);
    // 组织配置表是普通 CRUD：不得被 append-only 触发器拦截
    expect(guarded.has('users')).toBe(false);
    expect(guarded.has('roles')).toBe(false);
    expect(guarded.has('policies')).toBe(false);
    // 会话表（收尾波-③）：轻量运营状态，撤销 = UPDATE，不得被触发器拦截
    expect(guarded.has('sessions')).toBe(false);
    // 基础数据/待办同取舍（M1 增量 4-I）：配置数据与轻量运营状态，非事实表
    expect(guarded.has('items')).toBe(false);
    expect(guarded.has('resources')).toBe(false);
    expect(guarded.has('todos')).toBe(false);
    // 审批三表（M1 收尾波-①）：记录/事件账本 append-only；案件行是投影（豁免）
    expect(guarded.has('approval_records')).toBe(true);
    expect(guarded.has('approval_events')).toBe(true);
    expect(guarded.has('approval_cases')).toBe(false);
    // baseline P1（M2-W2）：版本化主数据与校验事实 append-only；幂等账本豁免
    expect(guarded.has('process_defs')).toBe(true);
    expect(guarded.has('equipment_records')).toBe(true);
    expect(guarded.has('outsourcing_price_rules')).toBe(true);
    expect(guarded.has('material_validation_runs')).toBe(true);
    expect(guarded.has('baseline_command_operations')).toBe(false);
    // workorder 六表（M2-W1）：事件账本与两事实表 append-only；投影两表随迁移
    // UPDATE 豁免；幂等记账无修正语义（写后不改）豁免——挂法见迁移头注。
    expect(guarded.has('workorder_events')).toBe(true);
    expect(guarded.has('work_order_attachments')).toBe(true);
    expect(guarded.has('kit_checks')).toBe(true);
    expect(guarded.has('work_orders')).toBe(false);
    expect(guarded.has('parts_requests')).toBe(false);
    expect(guarded.has('workorder_operations')).toBe(false);
    // inspection 四表（M2-W4）：事件账本 append-only；投影两表随判定/处置/闭环
    // 迁移 UPDATE 豁免（含 updateJudgment 与点名标记）；幂等记账豁免——挂法见
    // 迁移头注。
    expect(guarded.has('inspection_events')).toBe(true);
    expect(guarded.has('inspections')).toBe(false);
    expect(guarded.has('nonconformities')).toBe(false);
    expect(guarded.has('inspection_operations')).toBe(false);
    // listing 八表（M2-W3）：事件账本与缺口快照 append-only；五投影表行级更新豁免；
    // 幂等记账无修正语义（写后不改）豁免——挂法见迁移头注。
    expect(guarded.has('listing_events')).toBe(true);
    expect(guarded.has('gap_checks')).toBe(true);
    expect(guarded.has('listing_sheets')).toBe(false);
    expect(guarded.has('listing_lines')).toBe(false);
    expect(guarded.has('purchase_requests')).toBe(false);
    expect(guarded.has('purchase_orders')).toBe(false);
    expect(guarded.has('purchase_returns')).toBe(false);
    expect(guarded.has('listing_operations')).toBe(false);
    // dispatch 四表（M2-W6）：事件账本 append-only；两投影表随迁移/派工/单价补录
    // UPDATE 豁免（外协行单价补录 = 行级 object_version 条件更新）；幂等记账豁免
    // ——挂法见迁移头注。
    expect(guarded.has('dispatch_events')).toBe(true);
    expect(guarded.has('dispatch_orders')).toBe(false);
    expect(guarded.has('outsourcing_lines')).toBe(false);
    expect(guarded.has('dispatch_operations')).toBe(false);
    // inventory 十一表（M2-W5）：流水/放行事实/事件账本 append-only；主数据与
    // 投影/余额/预占/盘点/发货/幂等记账表豁免（行级条件更新或写后不改）——挂法
    // 见迁移头注。
    expect(guarded.has('stock_movements')).toBe(true);
    expect(guarded.has('release_facts')).toBe(true);
    expect(guarded.has('inventory_events')).toBe(true);
    expect(guarded.has('warehouses')).toBe(false);
    expect(guarded.has('warehouse_locations')).toBe(false);
    expect(guarded.has('stock_accounts')).toBe(false);
    expect(guarded.has('stock_location_balances')).toBe(false);
    expect(guarded.has('stock_reservations')).toBe(false);
    expect(guarded.has('stocktakes')).toBe(false);
    expect(guarded.has('shipping_orders')).toBe(false);
    expect(guarded.has('inventory_operations')).toBe(false);
    // hours 三表（M2-W6，账本域）：条目与月度快照 append-only（撤销/重算走追加
    // 新行）；幂等记账运营表豁免——挂法见 20261026020000_hours_module 迁移头注。
    expect(guarded.has('labor_entries')).toBe(true);
    expect(guarded.has('labor_ledger_months')).toBe(true);
    expect(guarded.has('hours_operations')).toBe(false);
    // costing 四表（M2-W6，账本域）：条目/口径版本/快照 append-only（修正/重定价/
    // 重算走追加新行）；幂等记账运营表豁免——挂法见 20261026030000_costing_module
    // 迁移头注。
    expect(guarded.has('cost_entries')).toBe(true);
    expect(guarded.has('costing_models')).toBe(true);
    expect(guarded.has('cost_snapshots')).toBe(true);
    expect(guarded.has('costing_operations')).toBe(false);
    // M3 payroll 四表（账本域）：规则版本/批次快照/薪酬记录 append-only（改价/
    // 重算走追加新行）；幂等记账运营表豁免——挂法见 20261026060000_payroll_module
    // 迁移头注。
    expect(guarded.has('payroll_rules')).toBe(true);
    expect(guarded.has('pay_runs')).toBe(true);
    expect(guarded.has('earnings_records')).toBe(true);
    expect(guarded.has('payroll_operations')).toBe(false);
    // M3 drawing 四表（版本化文档域）：修订链/通知/查看留痕 append-only（修订
    // 只追加、事后等级调整不追溯改写留痕）；幂等记账运营表豁免——挂法见
    // 20261026080000_drawing_module 迁移头注。
    expect(guarded.has('drawing_revisions')).toBe(true);
    expect(guarded.has('drawing_change_notices')).toBe(true);
    expect(guarded.has('drawing_view_trails')).toBe(true);
    expect(guarded.has('drawing_operations')).toBe(false);
    // M3 maintenance 四表（维保执行域）：计划版本/三态记录 append-only（修订走
    // 新版本行、留痕修正走冲销/补录）；任务投影行随状态机迁移行级条件更新豁免；
    // 幂等记账运营表豁免——挂法见 20261026070000_maintenance_module 迁移头注。
    expect(guarded.has('maintenance_plans')).toBe(true);
    expect(guarded.has('maintenance_tasks')).toBe(false);
    expect(guarded.has('maintenance_activities')).toBe(true);
    expect(guarded.has('maintenance_operations')).toBe(false);
    // T 波 S5 能力子集三表（配置数据/收件箱：菜单与审批配置可改可停用、通知
    // 已读标记 = UPDATE；均非 append-only 业务事实，不得被触发器拦截）。
    expect(guarded.has('menu_configs')).toBe(false);
    expect(guarded.has('approval_flow_configs')).toBe(false);
    expect(guarded.has('notifications')).toBe(false);
  });
});

describe('listing 八表（M2-W3：投影五表 + 缺口快照事实 + 事件账本 + 幂等记账）', () => {
  it('listing_sheets / listing_lines：投影行（清单唯一 + 行号唯一 + 校验状态字段 + 行级乐观版本；非事实表不套证据公共列）', () => {
    expectField('ListingSheetRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('ListingSheetRecord', 'workOrderId', 'String', ['@map("work_order_id")']);
    const sheetAttrs = models.get('ListingSheetRecord')!.blockAttrs.join('\n');
    expect(sheetAttrs).toContain('@@unique([tenantId, workOrderId, kind])');
    expect(sheetAttrs).toContain('@@map("listing_sheets")');
    expect(models.get('ListingSheetRecord')!.fields.has('objectVersion')).toBe(false);

    expectField('ListingLineRecord', 'sheetId', 'String', ['@map("sheet_id")']);
    expectField('ListingLineRecord', 'lineNo', 'Int', ['@map("line_no")']);
    expectField('ListingLineRecord', 'itemId', 'String?', ['@map("item_id")']);
    expectField('ListingLineRecord', 'validationStatus', 'String', ['@map("validation_status")']);
    expectField('ListingLineRecord', 'similarity', 'Float', ['@default(0)']);
    expectField('ListingLineRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    const lineAttrs = models.get('ListingLineRecord')!.blockAttrs.join('\n');
    expect(lineAttrs).toContain('@@unique([tenantId, sheetId, lineNo])');
    expect(lineAttrs).toContain('@@map("listing_lines")');
  });

  it('gap_checks：缺口核查不可变快照（证据公共列 TEXT 口径 + seq 游标，同 kit_checks 形态）', () => {
    expectField('GapCheckRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('GapCheckRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('GapCheckRecord', 'kinds', 'Json', []);
    expectField('GapCheckRecord', 'gapLines', 'Json', ['@map("gap_lines")']);
    expectField('GapCheckRecord', 'complete', 'Boolean', []);
    expectField('GapCheckRecord', 'checkedBy', 'String', ['@map("checked_by")']);
    expectField('GapCheckRecord', 'checkedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("checked_at")']);
    expectField('GapCheckRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('GapCheckRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('GapCheckRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('GapCheckRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('GapCheckRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('GapCheckRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('GapCheckRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@index([tenantId, workOrderId, checkedAt(sort: Desc), seq(sort: Desc)])');
    expect(attrs).toContain('@@map("gap_checks")');
  });

  it('purchase_requests / purchase_orders / purchase_returns：投影行（契约列 + 乐观版本 + JSONB 载荷）', () => {
    expectField('PurchaseRequestRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('PurchaseRequestRecord', 'sourceType', 'String', ['@map("source_type")']);
    expectField('PurchaseRequestRecord', 'sourceGapCheckId', 'String?', ['@map("source_gap_check_id")']);
    expectField('PurchaseRequestRecord', 'sourceListingLineId', 'String?', ['@map("source_listing_line_id")']);
    expectField('PurchaseRequestRecord', 'purchaseOrderId', 'String?', ['@map("purchase_order_id")']);
    const requestAttrs = models.get('PurchaseRequestRecord')!.blockAttrs.join('\n');
    expect(requestAttrs).toContain('@@index([tenantId, purchaseOrderId])');
    expect(requestAttrs).toContain('@@map("purchase_requests")');
    expect(models.get('PurchaseRequestRecord')!.fields.has('supersedes')).toBe(false);

    expectField('PurchaseOrderRecord', 'objectVersion', 'Int', ['@default(2)', '@map("object_version")']);
    expectField('PurchaseOrderRecord', 'promisedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("promised_at")']);
    expectField('PurchaseOrderRecord', 'lines', 'Json', []);
    expectField('PurchaseOrderRecord', 'requestIds', 'Json', ['@map("request_ids")']);
    expectField('PurchaseOrderRecord', 'receiptRef', 'String?', ['@map("receipt_ref")']);
    const orderAttrs = models.get('PurchaseOrderRecord')!.blockAttrs.join('\n');
    expect(orderAttrs).toContain('@@index([tenantId, state])');
    expect(orderAttrs).toContain('@@map("purchase_orders")');

    expectField('PurchaseReturnRecord', 'purchaseOrderId', 'String', ['@map("purchase_order_id")']);
    expectField('PurchaseReturnRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('PurchaseReturnRecord', 'lines', 'Json', []);
    expectField('PurchaseReturnRecord', 'returnedBy', 'String', ['@map("returned_by")']);
    expect(models.get('PurchaseReturnRecord')!.blockAttrs.join('\n')).toContain('@@map("purchase_returns")');
  });

  it('listing_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 workorder_events 形态）；listing_operations 幂等记账运营表', () => {
    expectField('ListingEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('ListingEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('ListingEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('ListingEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    const eventAttrs = models.get('ListingEventRecord')!.blockAttrs.join('\n');
    expect(eventAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(eventAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(eventAttrs).toContain('@@map("listing_events")');

    expectField('ListingOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('ListingOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    const opAttrs = models.get('ListingOperationRecord')!.blockAttrs.join('\n');
    expect(opAttrs).toContain('@@index([tenantId])');
    expect(opAttrs).toContain('@@map("listing_operations")');
    expect(models.get('ListingOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('ListingOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('dispatch 四表（M2-W6：投影两表 + 事件账本 + 幂等记账）', () => {
  it('dispatch_orders / outsourcing_lines：投影行（六类 kind + 零件工艺属性快照 + 外协单价补录行级乐观版本；非事实表不套证据公共列）', () => {
    expectField('DispatchOrderRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('DispatchOrderRecord', 'workOrderId', 'String?', ['@map("work_order_id")']);
    expectField('DispatchOrderRecord', 'kind', 'String', []);
    expectField('DispatchOrderRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('DispatchOrderRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('DispatchOrderRecord', 'drawingNo', 'String?', ['@map("drawing_no")']);
    expectField('DispatchOrderRecord', 'operationCode', 'String?', ['@map("operation_code")']);
    expectField('DispatchOrderRecord', 'material', 'String?', []);
    expectField('DispatchOrderRecord', 'sizeSpec', 'String?', ['@map("size_spec")']);
    expectField('DispatchOrderRecord', 'quantity', 'Float', []);
    expectField('DispatchOrderRecord', 'doneQty', 'Float', ['@default(0)', '@map("done_qty")']);
    expectField('DispatchOrderRecord', 'assignee', 'String?', []);
    const orderAttrs = models.get('DispatchOrderRecord')!.blockAttrs.join('\n');
    expect(orderAttrs).toContain('@@index([tenantId, state])');
    expect(orderAttrs).toContain('@@index([tenantId, workOrderId])');
    expect(orderAttrs).toContain('@@index([tenantId, assignee])');
    expect(orderAttrs).toContain('@@map("dispatch_orders")');
    expect(models.get('DispatchOrderRecord')!.fields.has('supersedes')).toBe(false);

    expectField('OutsourcingLineRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('OutsourcingLineRecord', 'dispatchId', 'String', ['@map("dispatch_id")']);
    expectField('OutsourcingLineRecord', 'lineNo', 'Int', ['@map("line_no")']);
    expectField('OutsourcingLineRecord', 'processCode', 'String', ['@map("process_code")']);
    expectField('OutsourcingLineRecord', 'supplierRef', 'String', ['@map("supplier_ref")']);
    expectField('OutsourcingLineRecord', 'unitPriceMinor', 'Int?', ['@map("unit_price_minor")']);
    expectField('OutsourcingLineRecord', 'priceSource', 'String?', ['@map("price_source")']);
    expectField('OutsourcingLineRecord', 'marginPermyriad', 'Int?', ['@map("margin_permyriad")']);
    expectField('OutsourcingLineRecord', 'promisedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("promised_at")']);
    expectField('OutsourcingLineRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    const lineAttrs = models.get('OutsourcingLineRecord')!.blockAttrs.join('\n');
    expect(lineAttrs).toContain('@@unique([tenantId, dispatchId, lineNo])');
    expect(lineAttrs).toContain('@@index([tenantId, supplierRef])');
    expect(lineAttrs).toContain('@@map("outsourcing_lines")');
    expect(models.get('OutsourcingLineRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('dispatch_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 workorder_events 形态）；dispatch_operations 幂等记账运营表', () => {
    expectField('DispatchEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('DispatchEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('DispatchEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('DispatchEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    const eventAttrs = models.get('DispatchEventRecord')!.blockAttrs.join('\n');
    expect(eventAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(eventAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(eventAttrs).toContain('@@map("dispatch_events")');

    expectField('DispatchOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('DispatchOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    const opAttrs = models.get('DispatchOperationRecord')!.blockAttrs.join('\n');
    expect(opAttrs).toContain('@@index([tenantId])');
    expect(opAttrs).toContain('@@map("dispatch_operations")');
    expect(models.get('DispatchOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('DispatchOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('inventory 十一表（M2-W5：主数据两表 + 库存/库位/预占投影三表 + 状态机投影两表 + 流水与放行事实两表 + 事件账本 + 幂等记账）', () => {
  it('warehouses / warehouse_locations：主数据投影（(tenant, code) 与 (tenant, 仓, code) 唯一；非事实表不套证据公共列）', () => {
    expectField('WarehouseRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('WarehouseRecord', 'defaultLocationId', 'String', ['@map("default_location_id")']);
    const whAttrs = models.get('WarehouseRecord')!.blockAttrs.join('\n');
    expect(whAttrs).toContain('@@unique([tenantId, code])');
    expect(whAttrs).toContain('@@map("warehouses")');
    expect(models.get('WarehouseRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('WarehouseRecord')!.fields.has('supersedes')).toBe(false);

    expectField('WarehouseLocationRecord', 'warehouseId', 'String', ['@map("warehouse_id")']);
    const locAttrs = models.get('WarehouseLocationRecord')!.blockAttrs.join('\n');
    expect(locAttrs).toContain('@@unique([tenantId, warehouseId, code])');
    expect(locAttrs).toContain('@@map("warehouse_locations")');
    expect(models.get('WarehouseLocationRecord')!.fields.has('objectVersion')).toBe(false);
  });

  it('stock_accounts / stock_location_balances：恒等式投影（唯一复合键 + 余额列；守卫条件更新在 PG 适配层）', () => {
    expectField('StockAccountRecord', 'itemId', 'String', ['@map("item_id")']);
    expectField('StockAccountRecord', 'qtyOnHand', 'Float', ['@default(0)', '@map("qty_on_hand")']);
    expectField('StockAccountRecord', 'qtyReserved', 'Float', ['@default(0)', '@map("qty_reserved")']);
    const accountAttrs = models.get('StockAccountRecord')!.blockAttrs.join('\n');
    expect(accountAttrs).toContain('@@unique([tenantId, itemId, warehouseId])');
    expect(accountAttrs).toContain('@@map("stock_accounts")');
    expect(models.get('StockAccountRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('StockAccountRecord')!.fields.has('supersedes')).toBe(false);

    expectField('StockLocationBalanceRecord', 'locationId', 'String', ['@map("location_id")']);
    const balanceAttrs = models.get('StockLocationBalanceRecord')!.blockAttrs.join('\n');
    expect(balanceAttrs).toContain('@@unique([tenantId, warehouseId, locationId, itemId])');
    expect(balanceAttrs).toContain('@@map("stock_location_balances")');
  });

  it('stock_movements：append-only 事实（证据公共列 TEXT 口径 + seq 游标 + (tenant, source_key) 幂等唯一——receiptKey/issueKey 锚点）', () => {
    expectField('StockMovementRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('StockMovementRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('StockMovementRecord', 'kind', 'String', []);
    expectField('StockMovementRecord', 'quantity', 'Float', []);
    expectField('StockMovementRecord', 'sourceKey', 'String?', ['@map("source_key")']);
    expectField('StockMovementRecord', 'transferId', 'String?', ['@map("transfer_id")']);
    expectField('StockMovementRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('StockMovementRecord', 'recordedBy', 'String', ['@map("recorded_by")']);
    expectField('StockMovementRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('StockMovementRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('StockMovementRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('StockMovementRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('StockMovementRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('StockMovementRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('StockMovementRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, sourceKey])');
    expect(attrs).toContain('@@index([tenantId, occurredAt(sort: Desc), seq(sort: Desc)])');
    expect(attrs).toContain('@@map("stock_movements")');
  });

  it('stock_reservations / stocktakes / shipping_orders：投影行（唯一键 + 乐观版本 + JSONB 载荷）', () => {
    expectField('StockReservationRecord', 'reservationKey', 'String', ['@map("reservation_key")']);
    expectField('StockReservationRecord', 'remaining', 'Float', []);
    expectField('StockReservationRecord', 'status', 'String', ['@default("active")']);
    const rsvAttrs = models.get('StockReservationRecord')!.blockAttrs.join('\n');
    expect(rsvAttrs).toContain('@@unique([tenantId, reservationKey])');
    expect(rsvAttrs).toContain('@@map("stock_reservations")');
    expect(models.get('StockReservationRecord')!.fields.has('supersedes')).toBe(false);

    expectField('StocktakeRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('StocktakeRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('StocktakeRecord', 'lines', 'Json', []);
    expectField('StocktakeRecord', 'openedBy', 'String', ['@map("opened_by")']);
    const stAttrs = models.get('StocktakeRecord')!.blockAttrs.join('\n');
    expect(stAttrs).toContain('@@index([tenantId, state])');
    expect(stAttrs).toContain('@@map("stocktakes")');

    expectField('ShippingOrderRecord', 'workOrderId', 'String?', ['@map("work_order_id")']);
    expectField('ShippingOrderRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('ShippingOrderRecord', 'lines', 'Json', []);
    expectField('ShippingOrderRecord', 'executedBy', 'String', ['@map("executed_by")']);
    expectField('ShippingOrderRecord', 'confirmedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("confirmed_at")']);
    const shipAttrs = models.get('ShippingOrderRecord')!.blockAttrs.join('\n');
    expect(shipAttrs).toContain('@@index([tenantId, state])');
    expect(shipAttrs).toContain('@@index([tenantId, workOrderId])');
    expect(shipAttrs).toContain('@@map("shipping_orders")');
  });

  it('inventory_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 listing_events 形态）；inventory_operations 幂等记账运营表；release_facts 放行事实', () => {
    expectField('InventoryEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('InventoryEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('InventoryEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('InventoryEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    const eventAttrs = models.get('InventoryEventRecord')!.blockAttrs.join('\n');
    expect(eventAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(eventAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(eventAttrs).toContain('@@map("inventory_events")');

    expectField('InventoryOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('InventoryOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    const opAttrs = models.get('InventoryOperationRecord')!.blockAttrs.join('\n');
    expect(opAttrs).toContain('@@index([tenantId])');
    expect(opAttrs).toContain('@@map("inventory_operations")');
    expect(models.get('InventoryOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('InventoryOperationRecord')!.fields.has('supersedes')).toBe(false);

    expectField('ReleaseFactRecord', 'inspectionId', 'String', ['@map("inspection_id")']);
    expectField('ReleaseFactRecord', 'phase', 'String', []);
    expectField('ReleaseFactRecord', 'quantity', 'Float', []);
    expectField('ReleaseFactRecord', 'releasedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("released_at")']);
    expectField('ReleaseFactRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('ReleaseFactRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    const factAttrs = models.get('ReleaseFactRecord')!.blockAttrs.join('\n');
    expect(factAttrs).toContain('@@unique([tenantId, inspectionId, phase])');
    expect(factAttrs).toContain('@@map("release_facts")');
  });
});

describe('reporting 四表（M2-W7：报工投影（supersedes 修正链 + business_time 补录）+ 留痕账 + 事件账本 + 幂等记账）', () => {
  it('work_reports：投影行（链尾口径索引 + 乐观版本 + supersedes/business_time 行为列——不套完整证据七列，投影取舍同 dispatch_orders）', () => {
    expectField('WorkReportRecord', 'dispatchId', 'String', ['@map("dispatch_id")']);
    expectField('WorkReportRecord', 'kind', 'String', []);
    expectField('WorkReportRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('WorkReportRecord', 'state', 'String', []);
    expectField('WorkReportRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('WorkReportRecord', 'doneQty', 'Float', ['@map("done_qty")']);
    expectField('WorkReportRecord', 'laborMinutes', 'Int', ['@map("labor_minutes")']);
    expectField('WorkReportRecord', 'reporter', 'String', []);
    expectField('WorkReportRecord', 'workOrderId', 'String?', ['@map("work_order_id")']);
    expectField('WorkReportRecord', 'drawingNo', 'String?', ['@map("drawing_no")']);
    expectField('WorkReportRecord', 'operationCode', 'String?', ['@map("operation_code")']);
    expectField('WorkReportRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('WorkReportRecord', 'businessTime', 'DateTime', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('WorkReportRecord', 'verifiedBy', 'String?', ['@map("verified_by")']);
    expectField('WorkReportRecord', 'verifiedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("verified_at")']);
    expectField('WorkReportRecord', 'revokedBy', 'String?', ['@map("revoked_by")']);
    expectField('WorkReportRecord', 'revokedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("revoked_at")']);
    expectField('WorkReportRecord', 'revokeReason', 'String?', ['@map("revoke_reason")']);
    const attrs = models.get('WorkReportRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@index([tenantId, state])');
    expect(attrs).toContain('@@index([tenantId, kind, state])');
    expect(attrs).toContain('@@index([tenantId, dispatchId])');
    expect(attrs).toContain('@@index([tenantId, reporter])');
    expect(attrs).toContain('@@index([tenantId, drawingNo])');
    expect(attrs).toContain('@@index([tenantId, supersedes])');
    expect(attrs).toContain('@@map("work_reports")');
    // 投影取舍：不套完整证据七列（supersedes/business_time 为行为需求列，auditStatus 不落）
    expect(models.get('WorkReportRecord')!.fields.has('auditStatus')).toBe(false);
  });

  it('report_audits：核查留痕 append-only 账（action/actor/reason/changes JSONB）', () => {
    expectField('ReportAuditRecord', 'reportId', 'String', ['@map("report_id")']);
    expectField('ReportAuditRecord', 'action', 'String', []);
    expectField('ReportAuditRecord', 'actor', 'String', []);
    expectField('ReportAuditRecord', 'changes', 'Json?', []);
    expectField('ReportAuditRecord', 'createdAt', 'DateTime', ['@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('ReportAuditRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@index([tenantId, reportId])');
    expect(attrs).toContain('@@map("report_audits")');
    expect(models.get('ReportAuditRecord')!.fields.has('objectVersion')).toBe(false);
  });

  it('reporting_events：seq 大单调游标 + eventId 幂等主约束 + (aggregate, revision) DB 级乐观锁（同 dispatch_events 形态）；reporting_operations 幂等记账运营表', () => {
    expectField('ReportingEventRecord', 'seq', 'BigInt', ['@id', '@default(autoincrement())', '@db.BigInt']);
    expectField('ReportingEventRecord', 'eventId', 'String', ['@unique', '@map("event_id")']);
    expectField('ReportingEventRecord', 'eventType', 'String', ['@db.VarChar(128)', '@map("event_type")']);
    expectField('ReportingEventRecord', 'aggregateRevision', 'Int', ['@map("aggregate_revision")']);
    const eventAttrs = models.get('ReportingEventRecord')!.blockAttrs.join('\n');
    expect(eventAttrs).toContain('@@unique([aggregateId, aggregateRevision])');
    expect(eventAttrs).toContain('@@index([tenantId, aggregateId, seq])');
    expect(eventAttrs).toContain('@@map("reporting_events")');

    expectField('ReportingOperationRecord', 'operationKey', 'String', ['@id', '@map("operation_key")']);
    expectField('ReportingOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    const opAttrs = models.get('ReportingOperationRecord')!.blockAttrs.join('\n');
    expect(opAttrs).toContain('@@index([tenantId])');
    expect(opAttrs).toContain('@@map("reporting_operations")');
    expect(models.get('ReportingOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('ReportingOperationRecord')!.fields.has('supersedes')).toBe(false);
  });

  it('append-only 触发器：report_audits 与 reporting_events 迁移声明护栏（同既有账本口径）', () => {
    const reportingMigration = readFileSync(
      join(packageRoot, 'prisma', 'migrations', '20261026010000_reporting_module', 'migration.sql'),
      'utf8',
    );
    expect(reportingMigration).toContain('CREATE TRIGGER "report_audits_append_only_guard"');
    expect(reportingMigration).toContain('CREATE TRIGGER "reporting_events_append_only_guard"');
    expect(reportingMigration).toContain('business_store_forbid_mutation');
  });
});

describe('hours 三表（M2-W6，08-hours.md v1.0：工时条目事实 + 月度归集快照 + 幂等记账运营表）', () => {
  it('labor_entries：append-only 事实（证据公共列 TEXT 口径 + seq 游标 + (tenant, source_key) 幂等唯一——报工联动锚点）', () => {
    expectField('LaborEntryRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('LaborEntryRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('LaborEntryRecord', 'workerId', 'String', ['@map("worker_id")']);
    expectField('LaborEntryRecord', 'workDate', 'String', ['@map("work_date")']);
    expectField('LaborEntryRecord', 'trade', 'String', []);
    expectField('LaborEntryRecord', 'hours', 'Float', []);
    expectField('LaborEntryRecord', 'direction', 'String', []);
    expectField('LaborEntryRecord', 'sourceReportId', 'String', ['@map("source_report_id")']);
    expectField('LaborEntryRecord', 'reverses', 'String?', []);
    expectField('LaborEntryRecord', 'workOrderId', 'String?', ['@map("work_order_id")']);
    expectField('LaborEntryRecord', 'sourceKey', 'String', ['@map("source_key")']);
    expectField('LaborEntryRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('LaborEntryRecord', 'recordedBy', 'String', ['@map("recorded_by")']);
    expectField('LaborEntryRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('LaborEntryRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('LaborEntryRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('LaborEntryRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('LaborEntryRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('LaborEntryRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('LaborEntryRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, sourceKey])');
    expect(attrs).toContain('@@index([tenantId, workerId, workDate])');
    expect(attrs).toContain('@@index([tenantId, workOrderId])');
    expect(attrs).toContain('@@map("labor_entries")');
  });

  it('labor_ledger_months：可重算快照（supersedes 链线性不变量：版本唯一 + 前任唯一）', () => {
    expectField('LaborLedgerMonthRecord', 'workerId', 'String', ['@map("worker_id")']);
    expectField('LaborLedgerMonthRecord', 'month', 'String', []);
    expectField('LaborLedgerMonthRecord', 'trade', 'String', []);
    expectField('LaborLedgerMonthRecord', 'totalHours', 'Float', ['@map("total_hours")']);
    expectField('LaborLedgerMonthRecord', 'entryCount', 'Int', ['@map("entry_count")']);
    expectField('LaborLedgerMonthRecord', 'rebuiltBy', 'String', ['@map("rebuilt_by")']);
    expectField('LaborLedgerMonthRecord', 'rebuiltAt', 'DateTime', ['@db.Timestamptz(6)', '@map("rebuilt_at")']);
    expectField('LaborLedgerMonthRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('LaborLedgerMonthRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('LaborLedgerMonthRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('LaborLedgerMonthRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('LaborLedgerMonthRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('LaborLedgerMonthRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('LaborLedgerMonthRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, workerId, month, trade, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, workerId, month])');
    expect(attrs).toContain('@@map("labor_ledger_months")');
  });

  it('hours_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一）', () => {
    expectField('HoursOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('HoursOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('HoursOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('HoursOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("hours_operations")');
    expect(models.get('HoursOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('HoursOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('costing 四表（M2-W6，09-costing.md v1.0：成本条目事实 + 口径版本主数据 + 快照 + 幂等记账运营表）', () => {
  it('cost_entries：append-only 事实（delta 条目指回基准 + (tenant, source_key) 幂等唯一；工时类条目金额列可空——R6 口径层换算）', () => {
    expectField('CostEntryRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('CostEntryRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('CostEntryRecord', 'workOrderId', 'String', ['@map("work_order_id")']);
    expectField('CostEntryRecord', 'category', 'String', []);
    expectField('CostEntryRecord', 'amountMinor', 'Int?', ['@map("amount_minor")']);
    expectField('CostEntryRecord', 'quantity', 'Float?', []);
    expectField('CostEntryRecord', 'trade', 'String?', []);
    expectField('CostEntryRecord', 'sourceType', 'String', ['@map("source_type")']);
    expectField('CostEntryRecord', 'sourceRefId', 'String', ['@map("source_ref_id")']);
    expectField('CostEntryRecord', 'sourceKey', 'String', ['@map("source_key")']);
    expectField('CostEntryRecord', 'deltaOf', 'String?', ['@map("delta_of")']);
    expectField('CostEntryRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('CostEntryRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('CostEntryRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('CostEntryRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('CostEntryRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('CostEntryRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('CostEntryRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('CostEntryRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, sourceKey])');
    expect(attrs).toContain('@@index([tenantId, workOrderId])');
    expect(attrs).toContain('@@index([tenantId, category])');
    expect(attrs).toContain('@@map("cost_entries")');
  });

  it('costing_models：口径版本化主数据（definition JSONB + 版本唯一 + 前任唯一——同 process_defs 形态）', () => {
    expectField('CostingModelRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('CostingModelRecord', 'code', 'String', []);
    expectField('CostingModelRecord', 'name', 'String?', []);
    expectField('CostingModelRecord', 'definition', 'Json', []);
    expectField('CostingModelRecord', 'status', 'String', ['@default("active")']);
    expectField('CostingModelRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('CostingModelRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('CostingModelRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('CostingModelRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('CostingModelRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('CostingModelRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('CostingModelRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, code, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, code])');
    expect(attrs).toContain('@@map("costing_models")');
  });

  it('cost_snapshots：可重算快照（工作令×口径版本链：五列唯一 + 前任唯一；totals JSONB 冻结值）', () => {
    expectField('CostSnapshotRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('CostSnapshotRecord', 'workOrderId', 'String', ['@map("work_order_id")']);
    expectField('CostSnapshotRecord', 'modelCode', 'String', ['@map("model_code")']);
    expectField('CostSnapshotRecord', 'modelVersion', 'Int', ['@map("model_version")']);
    expectField('CostSnapshotRecord', 'totals', 'Json', []);
    expectField('CostSnapshotRecord', 'rebuiltBy', 'String', ['@map("rebuilt_by")']);
    expectField('CostSnapshotRecord', 'rebuiltAt', 'DateTime', ['@db.Timestamptz(6)', '@map("rebuilt_at")']);
    expectField('CostSnapshotRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('CostSnapshotRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('CostSnapshotRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('CostSnapshotRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('CostSnapshotRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('CostSnapshotRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('CostSnapshotRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, workOrderId, modelCode, modelVersion, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, workOrderId])');
    expect(attrs).toContain('@@map("cost_snapshots")');
  });

  it('costing_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一）', () => {
    expectField('CostingOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('CostingOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('CostingOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('CostingOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("costing_operations")');
    expect(models.get('CostingOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('CostingOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('payroll 四表（M3，m3-drafts/01-payroll.md v1.0：计薪规则版本主数据 + 人×月批次快照 + 薪酬记录事实 + 幂等记账运营表）', () => {
  it('payroll_rules：计薪规则版本化主数据（scope JSONB 适用面 + 版本唯一 + 前任唯一——同 costing_models 形态）', () => {
    expectField('PayrollRuleRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('PayrollRuleRecord', 'ruleId', 'String', ['@map("rule_id")']);
    expectField('PayrollRuleRecord', 'name', 'String?', []);
    expectField('PayrollRuleRecord', 'basis', 'String', ['@default("hours")']);
    expectField('PayrollRuleRecord', 'rateMinor', 'Int', ['@map("rate_minor")']);
    expectField('PayrollRuleRecord', 'coefficient', 'Float', ['@default(1)']);
    expectField('PayrollRuleRecord', 'scope', 'Json', []);
    expectField('PayrollRuleRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('PayrollRuleRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('PayrollRuleRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('PayrollRuleRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('PayrollRuleRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('PayrollRuleRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    expectField('PayrollRuleRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('PayrollRuleRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, ruleId, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, ruleId])');
    expect(attrs).toContain('@@map("payroll_rules")');
  });

  it('pay_runs：人×月批次快照（可重算：版本唯一 + 前任唯一 + 规则版本集 JSONB；量纲 total_quantity=小时 / total_amount_minor=分）', () => {
    expectField('PayRunRecord', 'personId', 'String', ['@map("person_id")']);
    expectField('PayRunRecord', 'periodKey', 'String', ['@map("period_key")']);
    expectField('PayRunRecord', 'periodKind', 'String', ['@default("month")', '@map("period_kind")']);
    expectField('PayRunRecord', 'ruleVersions', 'Json', ['@map("rule_versions")']);
    expectField('PayRunRecord', 'totalQuantity', 'Float', ['@map("total_quantity")']);
    expectField('PayRunRecord', 'totalAmountMinor', 'Int', ['@map("total_amount_minor")']);
    expectField('PayRunRecord', 'lineCount', 'Int', ['@map("line_count")']);
    expectField('PayRunRecord', 'computedBy', 'String', ['@map("computed_by")']);
    expectField('PayRunRecord', 'computedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("computed_at")']);
    expectField('PayRunRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('PayRunRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('PayRunRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('PayRunRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('PayRunRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('PayRunRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('PayRunRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, periodKey, personId, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, periodKey])');
    expect(attrs).toContain('@@index([tenantId, personId])');
    expect(attrs).toContain('@@map("pay_runs")');
  });

  it('earnings_records：append-only 薪酬记录事实（证据公共列 TEXT 口径 + seq 游标 + (tenant, source_key) 幂等唯一；量纲冻结三列齐）', () => {
    expectField('EarningsRecordRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('EarningsRecordRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('EarningsRecordRecord', 'personId', 'String', ['@map("person_id")']);
    expectField('EarningsRecordRecord', 'periodKey', 'String', ['@map("period_key")']);
    expectField('EarningsRecordRecord', 'ruleId', 'String', ['@map("rule_id")']);
    expectField('EarningsRecordRecord', 'ruleVersion', 'Int', ['@map("rule_version")']);
    expectField('EarningsRecordRecord', 'basis', 'String', []);
    expectField('EarningsRecordRecord', 'laborKind', 'String', ['@map("labor_kind")']);
    expectField('EarningsRecordRecord', 'quantity', 'Float', []);
    expectField('EarningsRecordRecord', 'rateMinor', 'Int', ['@map("rate_minor")']);
    expectField('EarningsRecordRecord', 'coefficient', 'Float', []);
    expectField('EarningsRecordRecord', 'amountMinor', 'Int', ['@map("amount_minor")']);
    expectField('EarningsRecordRecord', 'payRunId', 'String', ['@map("pay_run_id")']);
    expectField('EarningsRecordRecord', 'sourceRefs', 'Json', ['@map("source_refs")']);
    expectField('EarningsRecordRecord', 'sourceKey', 'String', ['@map("source_key")']);
    expectField('EarningsRecordRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('EarningsRecordRecord', 'recordedBy', 'String', ['@map("recorded_by")']);
    expectField('EarningsRecordRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('EarningsRecordRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('EarningsRecordRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('EarningsRecordRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('EarningsRecordRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('EarningsRecordRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('EarningsRecordRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, sourceKey])');
    expect(attrs).toContain('@@index([tenantId, periodKey, personId])');
    expect(attrs).toContain('@@index([tenantId, payRunId])');
    expect(attrs).toContain('@@map("earnings_records")');
  });

  it('payroll_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一）', () => {
    expectField('PayrollOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('PayrollOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('PayrollOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('PayrollOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("payroll_operations")');
    expect(models.get('PayrollOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('PayrollOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('metric-pack 两表（M3，m3-drafts/04-metric-pack.md v1.0：口径包装载 append-only 事实 + 幂等记账运营表）', () => {
  it('metric_pack_activations：装载记录（pack JSONB 完整定义快照 + (tenant, pack_id, pack_version) 版本唯一 + 前任唯一——装载链线性）', () => {
    expectField('MetricPackActivationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MetricPackActivationRecord', 'packId', 'String', ['@map("pack_id")']);
    expectField('MetricPackActivationRecord', 'packVersion', 'Int', ['@map("pack_version")']);
    expectField('MetricPackActivationRecord', 'title', 'String', []);
    expectField('MetricPackActivationRecord', 'pack', 'Json', []);
    expectField('MetricPackActivationRecord', 'metricRefs', 'Json', ['@map("metric_refs")']);
    expectField('MetricPackActivationRecord', 'activatedBy', 'String', ['@map("activated_by")']);
    expectField('MetricPackActivationRecord', 'activatedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("activated_at")']);
    expectField('MetricPackActivationRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('MetricPackActivationRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('MetricPackActivationRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('MetricPackActivationRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('MetricPackActivationRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('MetricPackActivationRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    expectField('MetricPackActivationRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('MetricPackActivationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, packId, packVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, packId])');
    expect(attrs).toContain('@@map("metric_pack_activations")');
  });

  it('metric_pack_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一——同 payroll_operations 形态）', () => {
    expectField('MetricPackOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MetricPackOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('MetricPackOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('MetricPackOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("metric_pack_operations")');
    expect(models.get('MetricPackOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('MetricPackOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('drawing 四表（M3，m3-drafts/03-drawing.md v1.0：版本化修订链 append-only + 发布联动通知事实 + 查看留痕审计事实 + 幂等记账运营表）', () => {
  it('drawing_revisions：版本化文档修订链（(tenant, drawing_id, version) 与 (tenant, supersedes) 唯一；classification 保密等级数据值；supersedes_version 派生不落列）', () => {
    expectField('DrawingRevisionRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('DrawingRevisionRecord', 'drawingId', 'String', ['@map("drawing_id")']);
    expectField('DrawingRevisionRecord', 'version', 'Int', []);
    expectField('DrawingRevisionRecord', 'fileRef', 'String', ['@map("file_ref")']);
    expectField('DrawingRevisionRecord', 'changeNote', 'String', ['@map("change_note")']);
    expectField('DrawingRevisionRecord', 'classification', 'String', []);
    expectField('DrawingRevisionRecord', 'changedBy', 'String', ['@map("changed_by")']);
    expectField('DrawingRevisionRecord', 'changedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("changed_at")']);
    expectField('DrawingRevisionRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('DrawingRevisionRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('DrawingRevisionRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('DrawingRevisionRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('DrawingRevisionRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('DrawingRevisionRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    expectField('DrawingRevisionRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('DrawingRevisionRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, drawingId, version])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, drawingId])');
    expect(attrs).toContain('@@map("drawing_revisions")');
    // supersedes_version 不落列（version−1 派生口径，内存/PG 映射器同合同）
    expect(models.get('DrawingRevisionRecord')!.fields.has('supersedesVersion')).toBe(false);
  });

  it('drawing_change_notices：发布联动通知事实（from→to + (tenant, drawing_id, to_version) 联动幂等唯一；终端事实 supersedes 列在而恒空）', () => {
    expectField('DrawingChangeNoticeRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('DrawingChangeNoticeRecord', 'drawingId', 'String', ['@map("drawing_id")']);
    expectField('DrawingChangeNoticeRecord', 'fromVersion', 'Int', ['@map("from_version")']);
    expectField('DrawingChangeNoticeRecord', 'toVersion', 'Int', ['@map("to_version")']);
    expectField('DrawingChangeNoticeRecord', 'changeNote', 'String', ['@map("change_note")']);
    expectField('DrawingChangeNoticeRecord', 'publishedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("published_at")']);
    expectField('DrawingChangeNoticeRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('DrawingChangeNoticeRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    const attrs = models.get('DrawingChangeNoticeRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, drawingId, toVersion])');
    expect(attrs).toContain('@@index([tenantId, drawingId])');
    expect(attrs).toContain('@@map("drawing_change_notices")');
  });

  it('drawing_view_trails：查看留痕 append-only 审计事实（谁/何时/哪修订/当时等级快照 + seq bigserial 游标；保密审计最低门槛）', () => {
    expectField('DrawingViewTrailRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('DrawingViewTrailRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('DrawingViewTrailRecord', 'drawingId', 'String', ['@map("drawing_id")']);
    expectField('DrawingViewTrailRecord', 'version', 'Int', []);
    expectField('DrawingViewTrailRecord', 'viewedBy', 'String', ['@map("viewed_by")']);
    expectField('DrawingViewTrailRecord', 'viewedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("viewed_at")']);
    expectField('DrawingViewTrailRecord', 'classification', 'String', []);
    expectField('DrawingViewTrailRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    const attrs = models.get('DrawingViewTrailRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@index([tenantId, drawingId])');
    expect(attrs).toContain('@@index([tenantId, viewedBy])');
    expect(attrs).toContain('@@map("drawing_view_trails")');
    // 留痕无业务唯一键：每次查看都是新审计事实（唯一约束只出现在租户索引面）
    expect(attrs).not.toContain('@@unique');
  });

  it('drawing_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一——同 payroll/metric-pack 形态）', () => {
    expectField('DrawingOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('DrawingOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('DrawingOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('DrawingOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("drawing_operations")');
    expect(models.get('DrawingOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('DrawingOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});

describe('maintenance 四表（M3，m3-drafts/02-maintenance.md v1.0：计划版本主数据 + 任务状态机投影 + 三态记录事实 + 幂等记账运营表）', () => {
  it('maintenance_plans：维保计划版本化主数据（cycle/checkpoints/upkeep_actions JSONB——判据与动作清单是数据；版本唯一 + 前任唯一——同 payroll_rules 形态）', () => {
    expectField('MaintenancePlanRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MaintenancePlanRecord', 'planId', 'String', ['@map("plan_id")']);
    expectField('MaintenancePlanRecord', 'name', 'String?', []);
    expectField('MaintenancePlanRecord', 'resourceRef', 'String', ['@map("resource_ref")']);
    expectField('MaintenancePlanRecord', 'cycle', 'Json', []);
    expectField('MaintenancePlanRecord', 'checkpoints', 'Json', []);
    expectField('MaintenancePlanRecord', 'upkeepActions', 'Json', ['@map("upkeep_actions")']);
    expectField('MaintenancePlanRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('MaintenancePlanRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('MaintenancePlanRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('MaintenancePlanRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('MaintenancePlanRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('MaintenancePlanRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    expectField('MaintenancePlanRecord', 'createdAt', 'DateTime', ['@default(now())', '@db.Timestamptz(6)', '@map("created_at")']);
    const attrs = models.get('MaintenancePlanRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, planId, objectVersion])');
    expect(attrs).toContain('@@unique([tenantId, supersedes])');
    expect(attrs).toContain('@@index([tenantId, planId])');
    expect(attrs).toContain('@@index([tenantId, resourceRef])');
    expect(attrs).toContain('@@map("maintenance_plans")');
  });

  it('maintenance_tasks：任务状态机投影行（契约列 + 乐观版本 + flow_config_id 配置换代防线 + (tenant, source_key) 到期锚点唯一；非事实表不套证据公共列）', () => {
    expectField('MaintenanceTaskRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MaintenanceTaskRecord', 'flowConfigId', 'String', ['@map("flow_config_id")']);
    expectField('MaintenanceTaskRecord', 'source', 'String', []);
    expectField('MaintenanceTaskRecord', 'kind', 'String', []);
    expectField('MaintenanceTaskRecord', 'resourceRef', 'String', ['@map("resource_ref")']);
    expectField('MaintenanceTaskRecord', 'faultRef', 'String?', ['@map("fault_ref")']);
    expectField('MaintenanceTaskRecord', 'planId', 'String?', ['@map("plan_id")']);
    expectField('MaintenanceTaskRecord', 'planVersion', 'Int?', ['@map("plan_version")']);
    expectField('MaintenanceTaskRecord', 'dueKey', 'String?', ['@map("due_key")']);
    expectField('MaintenanceTaskRecord', 'dueAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("due_at")']);
    expectField('MaintenanceTaskRecord', 'assignee', 'String?', []);
    expectField('MaintenanceTaskRecord', 'state', 'String', []);
    expectField('MaintenanceTaskRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('MaintenanceTaskRecord', 'createdBy', 'String', ['@map("created_by")']);
    expectField('MaintenanceTaskRecord', 'startedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("started_at")']);
    expectField('MaintenanceTaskRecord', 'completedAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("completed_at")']);
    expectField('MaintenanceTaskRecord', 'cancelledAt', 'DateTime?', ['@db.Timestamptz(6)', '@map("cancelled_at")']);
    expectField('MaintenanceTaskRecord', 'cancelReason', 'String?', ['@map("cancel_reason")']);
    expectField('MaintenanceTaskRecord', 'sourceKey', 'String?', ['@map("source_key")']);
    const attrs = models.get('MaintenanceTaskRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, sourceKey])');
    expect(attrs).toContain('@@index([tenantId, state])');
    expect(attrs).toContain('@@index([tenantId, resourceRef])');
    expect(attrs).toContain('@@index([tenantId, assignee])');
    expect(attrs).toContain('@@index([tenantId, planId])');
    expect(attrs).toContain('@@map("maintenance_tasks")');
    // 投影行取舍：不套证据公共列（supersedes/auditStatus/provenance 不落）
    expect(models.get('MaintenanceTaskRecord')!.fields.has('supersedes')).toBe(false);
    expect(models.get('MaintenanceTaskRecord')!.fields.has('auditStatus')).toBe(false);
  });

  it('maintenance_activities：三态记录 append-only 事实（kind 判别三态列面 + 证据公共列 TEXT 口径 + seq 游标 + 设备×时窗下钻索引）', () => {
    expectField('MaintenanceActivityRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MaintenanceActivityRecord', 'seq', 'BigInt', ['@default(autoincrement())', '@db.BigInt']);
    expectField('MaintenanceActivityRecord', 'kind', 'String', []);
    expectField('MaintenanceActivityRecord', 'resourceRef', 'String', ['@map("resource_ref")']);
    expectField('MaintenanceActivityRecord', 'planId', 'String?', ['@map("plan_id")']);
    expectField('MaintenanceActivityRecord', 'planVersion', 'Int?', ['@map("plan_version")']);
    expectField('MaintenanceActivityRecord', 'taskId', 'String?', ['@map("task_id")']);
    expectField('MaintenanceActivityRecord', 'checkpointId', 'String?', ['@map("checkpoint_id")']);
    expectField('MaintenanceActivityRecord', 'result', 'String?', []);
    expectField('MaintenanceActivityRecord', 'actionsDone', 'Json?', ['@map("actions_done")']);
    expectField('MaintenanceActivityRecord', 'faultRef', 'String?', ['@map("fault_ref")']);
    expectField('MaintenanceActivityRecord', 'restored', 'Boolean?', []);
    expectField('MaintenanceActivityRecord', 'performedBy', 'String', ['@map("performed_by")']);
    expectField('MaintenanceActivityRecord', 'performedAt', 'DateTime', ['@db.Timestamptz(6)', '@map("performed_at")']);
    expectField('MaintenanceActivityRecord', 'occurredAt', 'DateTime', ['@db.Timestamptz(6)', '@map("occurred_at")']);
    expectField('MaintenanceActivityRecord', 'recordedBy', 'String', ['@map("recorded_by")']);
    expectField('MaintenanceActivityRecord', 'objectVersion', 'Int', ['@default(1)', '@map("object_version")']);
    expectField('MaintenanceActivityRecord', 'auditStatus', 'String', ['@map("audit_status")']);
    expectField('MaintenanceActivityRecord', 'provenance', 'Json?', ['@map("provenance")']);
    expectField('MaintenanceActivityRecord', 'supersedes', 'String?', ['@map("supersedes")']);
    expectField('MaintenanceActivityRecord', 'businessTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("business_time")']);
    expectField('MaintenanceActivityRecord', 'availableTime', 'DateTime?', ['@db.Timestamptz(6)', '@map("available_time")']);
    const attrs = models.get('MaintenanceActivityRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@index([tenantId, resourceRef, performedAt(sort: Desc), seq(sort: Desc)])');
    expect(attrs).toContain('@@index([tenantId, taskId])');
    expect(attrs).toContain('@@map("maintenance_activities")');
  });

  it('maintenance_operations：幂等记账（运营表：不套证据公共列，租户内 operationId 唯一——同 payroll/drawing 形态）', () => {
    expectField('MaintenanceOperationRecord', 'id', 'String', ['@id', '@default(uuid(7))']);
    expectField('MaintenanceOperationRecord', 'operationId', 'String', ['@map("operation_id")']);
    expectField('MaintenanceOperationRecord', 'commandKind', 'String', ['@map("command_kind")']);
    const attrs = models.get('MaintenanceOperationRecord')!.blockAttrs.join('\n');
    expect(attrs).toContain('@@unique([tenantId, operationId])');
    expect(attrs).toContain('@@map("maintenance_operations")');
    expect(models.get('MaintenanceOperationRecord')!.fields.has('objectVersion')).toBe(false);
    expect(models.get('MaintenanceOperationRecord')!.fields.has('supersedes')).toBe(false);
  });
});
