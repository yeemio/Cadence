/**
 * 工厂建模夹具种子（多角色界面测试 / 未来客户开通的标准环境初始化）。
 *
 * 方式取舍（沿 seed.mjs 体例）：显式运行（pnpm db:seed-factory = node
 * prisma/seed-factory.mjs，superuser 经 migrate 服务跑），不做启动期种子，
 * 不引 dist（参数/词汇内联钉死——同 seed.mjs 的 ruleKey/scrypt 先例）。
 * 幂等：全部固定 id/固定码 + createMany skipDuplicates / upsert 空更新，
 * 重跑零新增、不动既有行。
 *
 * 显式门（env）：SMES_FACTORY_SEED=on 才跑；缺省拒跑（exit 1）。主
 * seed.mjs 流程不变（本文件独立，不改动 seed.mjs / compose——compose 侧
 * 如需挂进 migrate 一次性服务属部署面改动，不在本脚本写入面，见交付说明）。
 *
 * ── 七岗位口径（总控裁定）─────────────────────────────────────────────
 * 六业务岗位新建账号（default 租户，口令统一 demo-password，scrypt 同当前
 * seed.mjs 内联参数——SP-2 档 N=65536 + maxmem 128MiB，自述格式串）：
 *   计划 plan01→plan-role / 采购 purch01→purch-role / 生产 prod01→prod-role /
 *   质检 qc01→qc-role / 仓管 wh01→wh-role / 审批 appr01→appr-role。
 * 第七岗位 = 只读观察者（viewer），由主 seed.mjs 既有 user-seed-viewer 承担
 * （无任何策略——e2e 403 证据身份），本脚本不建不删不动该账号。
 *
 * ── 角色绑码（ROLE_PERMISSIONS）───────────────────────────────────────
 * 码集从脚本头部 ROLE_PERMISSIONS 清单对象读（参数化，改码不改逻辑）。
 * 来源：architecture/ROLE-PACKS.md v1.0（2026-10-27 定稿）§1 七岗位标准
 * 角色包——已按文档核对填充（全员基线两码 workbench:read + notification:read
 * 含在各包内；码面 = 仓内真实 RequirePermission 常量 + 前端菜单门控码
 * scan:read）。角色名沿派发合同（plan-role 等）；ROLE-PACKS §1.0 建议的
 * 英文角色名（planner/purchaser/…）为别名口径，改roles 表展示时再议。
 * 第七岗位 observer（49 读码包，ROLE-PACKS §1.7）不落码：总控裁定 viewer
 * 由主 seed 的 user-seed-viewer 承担"零策略全拒形态"（e2e 403 证据身份），
 * 与 ROLE-PACKS §1.7"两种口径并存"的拒绝形态一致；"全读观察形态"另立
 * observer 账号属开通面决策，不在本种子。
 * 不种 roles 表：授权事实在 policies（同 seed.mjs 先例，roles 仅元数据面）。
 * 多租户口径（同 seed.mjs）：default 恒种全量；env SMES_TENANTS 各租户只种
 * 2 座工厂仓（含货架+库位，id 加 -<tenant> 后缀，同 MAIN 仓先例）；账号/
 * 策略/主数据/在制链只种 default（租户开通流程属 M4 后续波，同 seed.mjs）。
 *
 * ── 在制链直写取舍（沿 seed.mjs 直写表先例 + 命令信封语义完整）────────
 * seed 无 server 运行时，不装配 service：按各域真实命令路径（application
 * src/{workorder,listing,dispatch,inspection,baseline,inventory}）直写各域
 * 命令会产出的全部行，语义字段完整：
 *   - 投影行：终态形状（state/objectVersion 与真实命令链推进结果一致）；
 *   - 命令幂等账本：workorder/listing/dispatch/inspection/inventory
 *     *_operations（PK=租户|operationId）与 baseline_command_operations，
 *     operationId 确定性 = seed-factory-<n>（listing 物料校验子信封按真实
 *     派生规则 <operationId>#material）；
 *   - 域事件：event_records + outbox_records 双写（PG 适配为同事务原子
 *     双写；种子分两批 createMany——中断重跑自愈：events skipDuplicates、
 *     outbox 补齐）；provenance 按各域真实形状（workorder/listing/
 *     dispatch/inspection = {operationId, command, actor}；baseline =
 *     {operationId, issuedBy, commandKind, contract}）；
 *   - 机器事件账本：listing_events / dispatch_events 按迁移链逐条落
 *     （eventType=smes.<flowId>.v1.<eventAction>；(aggregateId, revision)
 *     逐版本递增，可被 replayOrder 重放）；创建类命令（工作令/质检单建单/
 *     派工建单）初始态无机器事件——同真实服务行为。
 * 在制链五单（全部挂同一工作令 wo-seed-factory-01）：
 *   工作令 not_started@1（四类清单骨架齐——设备采购清单在列）；
 *   零件清单已导入 5 行（挂图号 DWG-001~003，matched 判定）；
 *   采购订单 issued@4（submit→approve→issue 三命令链，待收货）；
 *   派工单 executing@3（create→assign→start，待报工，图号×工序在案）；
 *   质检单 pending@1（self_outsourced 手工建单，待判定）。
 *
 * ── 最小直写形态登记（无法走完整真实路径处的显式降级）────────────────
 *  1. listing.import(excel) 的物料校验子命令（baseline.material.validate.v1）
 *     已按真实派生 operationId（#material 后缀）落 material_validation_runs
 *     + baseline 账本 + material-validated 事件；判定行按 code-exact
 *     matched 形状直写（真实路径经 MaterialValidationExecutor 相似度计算）；
 *  2. 待办（todos）：真实命令链在当前终态下无 open 待办（提交待办已随
 *     approve 完成、派工待办已随 start 完成；issue/建质检单不产待办）——
 *     不落任何 todo 行，与真实链终态一致；
 *  3. 齐套/缺口快照（kit_checks / gap_checks）：非本轮夹具目标，不落。
 *
 * ── 可测形状（同 seed.mjs）────────────────────────────────────────────
 * 主逻辑收在 seedFactoryMain(prisma) 导出（PrismaClient 由调用方注入——
 * tests/seed-factory.test.ts 用内存桩锚定幂等与终态形状；类型面见
 * prisma/seed-factory.d.mts，同 seed.d.mts 先例）。直跑入口用 argv[1]
 * realpath 判断，被测试 import 时不触发副作用；env 门在入口处（先于
 * PrismaClient 实例化——无 DB 环境下 spawn 可验证拒跑行为）。
 *
 * 时间戳口径：全部固定常量（SEED_AT 基准 + 常量交期），重跑稳定；
 * id 口径：固定可读 id（wo-/ls-/ll-/po-/dsp-/insp-/itm-/cust-/sup- 前缀族）
 * + 确定性 UUID（sha256(tag)→UUIDv7 形状，供 @db.Uuid 列：工序/路线/
 * 额定工时/物料校验运行）。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const TENANT = 'default';

/** 显式门的开启值（SMES_FACTORY_SEED=on）。 */
const FACTORY_SEED_ENV_SWITCH = 'on';

/** 种子演示环境默认口令（同 seed.mjs：demo-password，明示非生产凭据）。 */
const DEFAULT_SEED_PASSWORD = 'demo-password';

// ---- 固定时间基准（确定性：重跑不漂移；ISO 串进事件载荷，Date 进列） ----
const SEED_AT = new Date('2026-10-27T08:00:00.000Z');
const SEED_AT_ISO = SEED_AT.toISOString();
const PLANNED_DELIVERY_AT = new Date('2026-12-15T00:00:00.000Z');
const PACKAGING_ARRIVAL_AT = new Date('2026-11-20T00:00:00.000Z');
const NEEDED_BY_AT = new Date('2026-11-10T00:00:00.000Z');
const PROMISED_AT = new Date('2026-11-15T00:00:00.000Z');
const PROMISED_AT_ISO = PROMISED_AT.toISOString();
const DUE_AT = new Date('2026-11-25T00:00:00.000Z');
const DUE_AT_ISO = DUE_AT.toISOString();

// ---- 命令操作者（actor；引用本种子/主 seed 身份，provenance 语义无外键） ----
const ACTOR_PLAN = 'user-factory-plan';
const ACTOR_PURCH = 'user-factory-purch';
const ACTOR_PROD = 'user-factory-prod';
const ACTOR_QC = 'user-factory-qc';
const ACTOR_APPR = 'user-factory-appr';
const ACTOR_ADMIN = 'user-seed-admin'; // 主 seed 身份（前置：db:seed 已跑）

// ---- 在制链固定锚点 id ----
const WORK_ORDER_ID = 'wo-seed-factory-01';
const PURCHASE_ORDER_ID = 'po-seed-factory-01';
const DISPATCH_ID = 'dsp-seed-factory-01';
const INSPECTION_ID = 'insp-seed-factory-01';
const SHEET_IDS = {
  part: 'ls-seed-factory-part',
  standard: 'ls-seed-factory-standard',
  electrical: 'ls-seed-factory-electrical',
  equipment: 'ls-seed-factory-equipment',
};
const LISTING_KIND_LABELS = {
  part: '零件清单',
  standard: '标准件清单',
  electrical: '电气件清单',
  equipment: '设备采购清单',
};

/**
 * 确定性 UUID（@db.Uuid 列用）：sha256("seed-factory:<tag>") 映射为
 * UUIDv7 形状（版本/变体位钉 7/8）。种子固定 id 需跨重跑稳定，不用随机。
 */
function seedUuid(tag) {
  const hex = createHash('sha256').update(`seed-factory:${tag}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** 口令哈希：与当前 seed.mjs 内联参数同源同格式（SP-2 档：N=65536 + maxmem 128MiB）。 */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 65536, 8, 1, salt.toString('hex'), hash.toString('hex')].join('$');
}

/** 策略规范键：与 src/org/policy-mapping.ts 同形状（种子不引 dist，内联钉死）。 */
function ruleKey(rule) {
  return rule.kind === 'grant-role'
    ? `grant-role|${rule.tenant}|${rule.user}|${rule.role}`
    : `grant-permission|${rule.tenant}|${rule.role}|${rule.resource}|${rule.action}`;
}

// ---------------------------------------------------------------------------
// 七岗位（六业务岗 + viewer 由主 seed 承担）：账号 + 角色 + 权限码
// ---------------------------------------------------------------------------

/** 六业务岗位账号（default 租户；viewer = 第七岗，主 seed 承担，不动）。 */
const FACTORY_ACCOUNTS = [
  { id: 'user-factory-plan', username: 'plan01', role: 'plan-role', displayName: '工厂演示·计划（plan01）' },
  { id: 'user-factory-purch', username: 'purch01', role: 'purch-role', displayName: '工厂演示·采购（purch01）' },
  { id: 'user-factory-prod', username: 'prod01', role: 'prod-role', displayName: '工厂演示·生产（prod01）' },
  { id: 'user-factory-qc', username: 'qc01', role: 'qc-role', displayName: '工厂演示·质检（qc01）' },
  { id: 'user-factory-wh', username: 'wh01', role: 'wh-role', displayName: '工厂演示·仓管（wh01）' },
  { id: 'user-factory-appr', username: 'appr01', role: 'appr-role', displayName: '工厂演示·审批（appr01）' },
];

/**
 * 岗位 → 权限码集（来源：architecture/ROLE-PACKS.md v1.0 §1，已按文档核对；
 * 全员基线两码 workbench:read + notification:read 含在各包；码数
 * 14/9/11/7/17/8——plan-role 相对文档 §1.0 的 13 码多 1 码 parts:approve，
 * 依据见下方行内注（AP-SEED-01 修复；文档侧同步待 ROLE-PACKS 换版）。
 */
const ROLE_PERMISSIONS = {
  'plan-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'workorder', action: 'read' },
    { resource: 'workorder', action: 'write' },
    { resource: 'listing', action: 'read' },
    { resource: 'listing', action: 'import' },
    { resource: 'listing', action: 'write' },
    { resource: 'gap', action: 'read' },
    { resource: 'kit', action: 'read' },
    { resource: 'kit', action: 'refresh' },
    { resource: 'item', action: 'read' },
    { resource: 'parts', action: 'read' },
    { resource: 'parts', action: 'request' },
    // AP-SEED-01（Round-2 缺陷修复）：工厂夹具工作令 wo-seed-factory-01 的
    // manager = plan01，而配件三级审批链一级审批人 = 工作令项目经理（空回落
    // 销售；ROLE-PACKS §1.6「三级链实态」）——plan01 在本夹具中兼任该项目
    // 经理即被派为一级审批人，无 parts:approve 则 UI 判可批而 API 403，阻断
    // 多级链。此处补审批专码（与 appr-role §1.6 同码），文档 §1.0 计划包
    // 13 码的换版同步归文档 Owner。
    { resource: 'parts', action: 'approve' },
  ],
  'purch-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'purchase', action: 'read' },
    { resource: 'purchase', action: 'request' },
    { resource: 'purchase', action: 'order' },
    { resource: 'purchase', action: 'receive' },
    { resource: 'purchase', action: 'return' },
    { resource: 'supplier', action: 'read' },
    { resource: 'item', action: 'read' },
  ],
  'prod-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'dispatch', action: 'read' },
    { resource: 'dispatch', action: 'write' },
    { resource: 'dispatch', action: 'assign' },
    { resource: 'dispatch', action: 'cancel' },
    { resource: 'report', action: 'submit' },
    { resource: 'report', action: 'read' },
    { resource: 'scan', action: 'read' },
    { resource: 'hours', action: 'read' },
    { resource: 'fault', action: 'report' },
  ],
  'qc-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'inspection', action: 'read' },
    { resource: 'inspection', action: 'judge' },
    { resource: 'nonconform', action: 'read' },
    { resource: 'nonconform', action: 'dispose' },
    { resource: 'nonconform', action: 'close' },
  ],
  'wh-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'warehouse', action: 'read' },
    { resource: 'warehouse', action: 'write' },
    { resource: 'stock', action: 'read' },
    { resource: 'stock', action: 'receive' },
    { resource: 'stock', action: 'issue' },
    { resource: 'stock', action: 'transfer' },
    { resource: 'stocktake', action: 'read' },
    { resource: 'stocktake', action: 'record' },
    { resource: 'stocktake', action: 'approve' },
    { resource: 'shipping', action: 'read' },
    { resource: 'shipping', action: 'execute' },
    { resource: 'issue', action: 'read' },
    { resource: 'issue', action: 'write' },
    { resource: 'issue', action: 'revoke' },
    { resource: 'purchase', action: 'receive' },
  ],
  'appr-role': [
    { resource: 'workbench', action: 'read' },
    { resource: 'notification', action: 'read' },
    { resource: 'approval', action: 'read' },
    { resource: 'approval', action: 'write' },
    { resource: 'purchase', action: 'read' },
    { resource: 'purchase', action: 'approve' },
    { resource: 'parts', action: 'read' },
    { resource: 'parts', action: 'approve' },
  ],
};

// ---------------------------------------------------------------------------
// 主数据（default 租户；客户/供应商/物料为配置类 CRUD 表——无事件/账本）
// ---------------------------------------------------------------------------

const FACTORY_CUSTOMERS = [
  { id: 'cust-seed-factory-001', code: 'CUST-001', name: '演示客户甲', contact: '13800000001' },
  { id: 'cust-seed-factory-002', code: 'CUST-002', name: '演示客户乙', contact: '13800000002' },
];

const FACTORY_SUPPLIERS = [
  { id: 'sup-seed-factory-001', code: 'SUP-001', name: '演示供应商甲' },
  { id: 'sup-seed-factory-002', code: 'SUP-002', name: '演示供应商乙' },
  { id: 'sup-seed-factory-003', code: 'SUP-003', name: '演示供应商丙' },
];

/** 物料 10（ITM-001~010，含单位/规格；行业语义只进数据行——ADR-0010）。 */
const FACTORY_ITEMS = [
  { id: 'itm-seed-factory-001', code: 'ITM-001', name: '中厚钢板 δ10', spec: '2440×1220×10mm', unit: '张', category: '原材料' },
  { id: 'itm-seed-factory-002', code: 'ITM-002', name: '圆钢 Φ60', spec: 'Φ60×6000mm', unit: 'kg', category: '原材料' },
  { id: 'itm-seed-factory-003', code: 'ITM-003', name: '不锈钢板 δ2', spec: '1000×2000×2mm', unit: '张', category: '原材料' },
  { id: 'itm-seed-factory-004', code: 'ITM-004', name: '内六角螺栓 M12×40', spec: 'M12×40 12.9级', unit: '套', category: '标准件' },
  { id: 'itm-seed-factory-005', code: 'ITM-005', name: '深沟球轴承 6205', spec: '6205-2RS', unit: '件', category: '标准件' },
  { id: 'itm-seed-factory-006', code: 'ITM-006', name: '焊接钢管 Φ60×4', spec: 'Φ60×4mm', unit: 'kg', category: '原材料' },
  { id: 'itm-seed-factory-007', code: 'ITM-007', name: '三相异步电机 2.2kW', spec: '2.2kW 4P', unit: '台', category: '电气件' },
  { id: 'itm-seed-factory-008', code: 'ITM-008', name: '交流接触器 24V', spec: 'AC24V 25A', unit: '件', category: '电气件' },
  { id: 'itm-seed-factory-009', code: 'ITM-009', name: '实心焊丝 ER50-6 Φ1.2', spec: 'Φ1.2mm', unit: 'kg', category: '辅料' },
  { id: 'itm-seed-factory-010', code: 'ITM-010', name: '醇酸防锈漆 灰', spec: '15kg/桶', unit: '桶', category: '辅料' },
];

/**
 * 工序 8（车/铣/刨/磨/钳/焊/装配/电检）+ 每件标准工时（分钟）与预备工时
 * （分钟）——落库为秒整数（standard_times 量纲，baseline 体例）。
 */
const FACTORY_PROCESSES = [
  { code: 'OP-001', name: '车削', standardMinutes: 30, preparationMinutes: 15 },
  { code: 'OP-002', name: '铣削', standardMinutes: 25, preparationMinutes: 15 },
  { code: 'OP-003', name: '刨削', standardMinutes: 20, preparationMinutes: 10 },
  { code: 'OP-004', name: '磨削', standardMinutes: 40, preparationMinutes: 20 },
  { code: 'OP-005', name: '钳工', standardMinutes: 15, preparationMinutes: 10 },
  { code: 'OP-006', name: '焊接', standardMinutes: 35, preparationMinutes: 20 },
  { code: 'OP-007', name: '装配', standardMinutes: 60, preparationMinutes: 30 },
  { code: 'OP-008', name: '电检', standardMinutes: 20, preparationMinutes: 10 },
];

/** 工艺路线 3（code = 图号 DWG-001~003；3~5 步工序链）。 */
const FACTORY_ROUTINGS = [
  {
    code: 'DWG-001',
    name: '传动轴（演示）',
    steps: [
      { seq: 1, processCode: 'OP-001', remark: '粗精车外圆' },
      { seq: 2, processCode: 'OP-004', remark: '磨轴颈' },
      { seq: 3, processCode: 'OP-005', remark: '去毛刺检验' },
    ],
  },
  {
    code: 'DWG-002',
    name: '支撑座（演示）',
    steps: [
      { seq: 1, processCode: 'OP-002', remark: '铣基准面' },
      { seq: 2, processCode: 'OP-003', remark: '刨导轨面' },
      { seq: 3, processCode: 'OP-006', remark: '焊接筋板' },
      { seq: 4, processCode: 'OP-007', remark: '总装配件' },
    ],
  },
  {
    code: 'DWG-003',
    name: '控制柜（演示）',
    steps: [
      { seq: 1, processCode: 'OP-001', remark: '车接线端座' },
      { seq: 2, processCode: 'OP-002', remark: '铣安装孔' },
      { seq: 3, processCode: 'OP-006', remark: '焊柜体骨架' },
      { seq: 4, processCode: 'OP-007', remark: '装配元器件' },
      { seq: 5, processCode: 'OP-008', remark: '电气检验' },
    ],
  },
];

/**
 * 仓库 2（B3 形态：直属库位 + 货架 + 货架库位）。default 恒种；SMES_TENANTS
 * 各租户同码幂等种（非 default 租户 id 加 -<tenant> 后缀，同 MAIN 仓先例）。
 * 与主 seed 的 MAIN 仓并存（互不触碰）。
 */
const FACTORY_WAREHOUSES = [
  {
    idBase: 'wh-seed-raw',
    code: 'RAW',
    name: '原材料仓（演示）',
    locationIdBase: 'loc-seed-raw',
    locations: [
      { suffix: 'a01', code: 'RAW-A01', name: '板材区 A01' },
      { suffix: 'a02', code: 'RAW-A02', name: '型材区 A02' },
    ],
    shelf: {
      idBase: 'gs-seed-raw-01',
      code: 'HLF-RAW-01',
      name: '重型货架 A 区',
      locationIdBase: 'sloc-seed-raw',
      locations: [
        { suffix: 'a', code: 'HLF-RAW-01-A', name: '重型货架 A 区·A 位' },
        { suffix: 'b', code: 'HLF-RAW-01-B', name: '重型货架 A 区·B 位' },
        { suffix: 'c', code: 'HLF-RAW-01-C', name: '重型货架 A 区·C 位' },
      ],
    },
  },
  {
    idBase: 'wh-seed-fg',
    code: 'FG',
    name: '成品仓（演示）',
    locationIdBase: 'loc-seed-fg',
    locations: [{ suffix: 'a01', code: 'FG-A01', name: '成品库位 A01' }],
    shelf: {
      idBase: 'gs-seed-fg-01',
      code: 'HLF-FG-01',
      name: '成品货架 B 区',
      locationIdBase: 'sloc-seed-fg',
      locations: [
        { suffix: 'a', code: 'HLF-FG-01-A', name: '成品货架 B 区·A 位' },
        { suffix: 'b', code: 'HLF-FG-01-B', name: '成品货架 B 区·B 位' },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// 零件清单导入行（listing.import excel 源；5 行挂图号，code-exact matched）
// ---------------------------------------------------------------------------

const PART_IMPORT_LINES = [
  { lineNo: 1, drawingNo: 'DWG-001', code: 'ITM-002', name: '圆钢 Φ60', spec: 'Φ60×6000mm', requiredQty: 12 },
  { lineNo: 2, drawingNo: 'DWG-001', code: 'ITM-005', name: '深沟球轴承 6205', spec: '6205-2RS', requiredQty: 4 },
  { lineNo: 3, drawingNo: 'DWG-002', code: 'ITM-001', name: '中厚钢板 δ10', spec: '2440×1220×10mm', requiredQty: 6 },
  { lineNo: 4, drawingNo: 'DWG-003', code: 'ITM-008', name: '交流接触器 24V', spec: 'AC24V 25A', requiredQty: 8 },
  { lineNo: 5, drawingNo: 'DWG-003', code: 'ITM-009', name: '实心焊丝 ER50-6 Φ1.2', spec: 'Φ1.2mm', requiredQty: 5 },
];

/** 采购订单行（JSONB 载荷形状 = listing PurchaseOrderLine）。 */
const PURCHASE_ORDER_LINES = [
  { lineNo: 1, itemId: 'itm-seed-factory-002', drawingNo: null, quantity: 200, unitPriceMinor: 450, receivedQty: 0 },
  { lineNo: 2, itemId: 'itm-seed-factory-004', drawingNo: null, quantity: 500, unitPriceMinor: 80, receivedQty: 0 },
];

// ---------------------------------------------------------------------------
// operationId 确定性编号（seed-factory-<n>；listing 物料校验子信封按真实
// 派生规则加 #material 后缀；30~33 为仓库/货架命令，各租户复用同号——
// 账本键含租户前缀）
// ---------------------------------------------------------------------------
const OP = {
  workorderCreate: 'seed-factory-1',
  listingImportSkeleton: 'seed-factory-2',
  listingImportPart: 'seed-factory-3', // 子信封 = seed-factory-3#material
  purchaseSubmit: 'seed-factory-4',
  purchaseApprove: 'seed-factory-5',
  purchaseIssue: 'seed-factory-6',
  dispatchCreate: 'seed-factory-7',
  dispatchAssign: 'seed-factory-8',
  dispatchStart: 'seed-factory-9',
  inspectionCreate: 'seed-factory-10',
  // 11~18 = baseline.process.define OP-001~008；19~21 = routing DWG-001~003；
  // 22~29 = standardtime ST-OP-001~008（主循环内按序生成）；
  // 30/31 = RAW 仓 warehouse.define + goods-shelf.define；
  // 32/33 = FG 仓同上（各租户复用同号，账本键 = 租户|operationId）。
  processBase: 11,
  routingBase: 19,
  standardTimeBase: 22,
  warehouseOpsBase: 30,
};

/** eventId 计数器（域事件与机器事件统一编号；跨表不冲突且顺序确定）。 */
let eventSeq = 0;
function nextEventId() {
  eventSeq += 1;
  return `evt-seed-factory-${eventSeq}`;
}

/** 域事件行（event_records；businessTime 仅 baseline 事件携带——真实形状）。 */
function domainEvent({ eventType, aggregateId, aggregateType, aggregateRevision, payload, provenance, businessTime }) {
  return {
    eventId: nextEventId(),
    tenantId: TENANT,
    eventType,
    aggregateId,
    aggregateType,
    aggregateRevision,
    occurredAt: SEED_AT,
    ...(businessTime === undefined ? {} : { businessTime }),
    provenance,
    payload,
  };
}

/** 机器事件行（listing_events / dispatch_events；payload = engine-flow ApprovalEventPayload）。 */
function machineEvent({ flowId, eventAction, aggregateType, aggregateId, revision, from, to, event, reason, actor, record }) {
  return {
    eventId: nextEventId(),
    tenantId: TENANT,
    eventType: `smes.${flowId}.v1.${eventAction}`,
    aggregateId,
    aggregateType,
    aggregateRevision: revision,
    occurredAt: SEED_AT,
    payload: {
      flowId,
      from,
      to,
      event,
      objectVersion: revision,
      actor,
      reason,
      ...(record === undefined ? {} : { record }),
    },
  };
}

/** 命令幂等账本行（operation_key = 租户|operationId 的五域同构形态）。 */
function operationRow(tenant, operationId, command, aggregateType, aggregateId) {
  return {
    operationKey: `${tenant}|${operationId}`,
    tenantId: tenant,
    operationId,
    command,
    aggregateType,
    aggregateId,
    occurredAt: SEED_AT,
  };
}

const moduleProvenance = (operationId, command, actor) => ({ operationId, command, actor });
const baselineProvenance = (operationId, commandKind) => ({
  operationId,
  issuedBy: ACTOR_ADMIN,
  commandKind,
  contract: 'smes.command.v1',
});

/** 种子租户清单（同 seed.mjs：default 恒种 + env SMES_TENANTS 去重去空）。 */
function seedTenants() {
  const extra = (process.env['SMES_TENANTS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== TENANT);
  return [TENANT, ...extra];
}

// ---------------------------------------------------------------------------
// 主逻辑（幂等）：账号/策略 → 主数据 → baseline 版本行+账本+事件 →
// 仓库（B3，每租户）→ 在制链（投影+机器事件+域事件/outbox+账本）
// ---------------------------------------------------------------------------

export async function seedFactoryMain(prisma) {
  // eventId 序号归零：每次种子运行从同一序号起编——同进程连跑（测试）与跨
  // 进程重跑（真实）产出同一批确定性 eventId，skipDuplicates 幂等口径一致。
  eventSeq = 0;

  // ── 1. 账号 + casbin 两形态授权（grant-role / grant-permission）────────
  const users = await prisma.userRecord.createMany({
    data: FACTORY_ACCOUNTS.map(({ id, username, displayName }) => ({
      id,
      username,
      displayName,
      tenantId: TENANT,
      active: true,
      passwordHash: hashPassword(DEFAULT_SEED_PASSWORD),
    })),
    skipDuplicates: true,
  });

  const policiesData = [];
  for (const account of FACTORY_ACCOUNTS) {
    policiesData.push({ kind: 'grant-role', tenant: TENANT, user: account.id, role: account.role });
    for (const { resource, action } of ROLE_PERMISSIONS[account.role]) {
      policiesData.push({ kind: 'grant-permission', tenant: TENANT, role: account.role, resource, action });
    }
  }
  const policies = await prisma.policyRecord.createMany({
    data: policiesData.map((rule) => ({
      ruleKey: ruleKey(rule),
      tenantId: rule.tenant,
      kind: rule.kind,
      userId: rule.kind === 'grant-role' ? rule.user : null,
      role: rule.role,
      resource: rule.kind === 'grant-permission' ? rule.resource : null,
      action: rule.kind === 'grant-permission' ? rule.action : null,
    })),
    skipDuplicates: true,
  });

  // ── 2. 主数据（配置类 CRUD：客户/供应商/物料——无事件/账本）────────────
  const customers = await prisma.customerRecord.createMany({
    data: FACTORY_CUSTOMERS.map(({ id, code, name, contact }) => ({ id, code, name, contact, tenantId: TENANT, active: true })),
    skipDuplicates: true,
  });
  const suppliers = await prisma.supplierRecord.createMany({
    data: FACTORY_SUPPLIERS.map(({ id, code, name }) => ({ id, code, name, tenantId: TENANT, active: true })),
    skipDuplicates: true,
  });
  const items = await prisma.itemRecord.createMany({
    data: FACTORY_ITEMS.map(({ id, code, name, spec, unit, category }) => ({
      id,
      tenantId: TENANT,
      code,
      name,
      spec,
      unit,
      category,
      active: true,
    })),
    skipDuplicates: true,
  });

  // ── 3. baseline 版本化主数据（工序/路线/额定工时：版本行+账本+域事件）──
  const baselineOperations = [];
  const masterEvents = [];

  const processRows = FACTORY_PROCESSES.map((process, index) => {
    const operationId = `seed-factory-${OP.processBase + index}`;
    baselineOperations.push({
      tenantId: TENANT,
      operationId,
      commandKind: 'baseline.process.define.v1',
      claimedAt: SEED_AT,
    });
    const provenance = baselineProvenance(operationId, 'baseline.process.define.v1');
    const row = {
      id: seedUuid(`process-${process.code}`),
      tenantId: TENANT,
      code: process.code,
      name: process.name,
      category: null,
      description: `工厂演示工序（标准工时 ${process.standardMinutes} 分钟/件）`,
      status: 'active',
      objectVersion: 1,
      auditStatus: 'unaudited',
      provenance,
      supersedes: null,
      businessTime: SEED_AT,
    };
    masterEvents.push(
      domainEvent({
        eventType: 'smes.baseline.v1.process-defined',
        aggregateId: process.code,
        aggregateType: 'baseline-process',
        aggregateRevision: 1,
        payload: { action: 'define', code: process.code, objectVersion: 1, status: 'active', supersedes: null, rowId: row.id },
        provenance,
        businessTime: SEED_AT_ISO,
      }),
    );
    return row;
  });

  const routingRows = FACTORY_ROUTINGS.map((routing, index) => {
    const operationId = `seed-factory-${OP.routingBase + index}`;
    baselineOperations.push({
      tenantId: TENANT,
      operationId,
      commandKind: 'baseline.routing.define.v1',
      claimedAt: SEED_AT,
    });
    const provenance = baselineProvenance(operationId, 'baseline.routing.define.v1');
    const row = {
      id: seedUuid(`routing-${routing.code}`),
      tenantId: TENANT,
      code: routing.code,
      name: routing.name,
      steps: routing.steps,
      status: 'active',
      objectVersion: 1,
      auditStatus: 'unaudited',
      provenance,
      supersedes: null,
      businessTime: SEED_AT,
    };
    masterEvents.push(
      domainEvent({
        eventType: 'smes.baseline.v1.routing-revised',
        aggregateId: routing.code,
        aggregateType: 'baseline-routing',
        aggregateRevision: 1,
        payload: { action: 'define', code: routing.code, objectVersion: 1, status: 'active', supersedes: null, rowId: row.id },
        provenance,
        businessTime: SEED_AT_ISO,
      }),
    );
    return row;
  });

  const standardTimeRows = FACTORY_PROCESSES.map((process, index) => {
    const code = `ST-${process.code}`;
    const operationId = `seed-factory-${OP.standardTimeBase + index}`;
    baselineOperations.push({
      tenantId: TENANT,
      operationId,
      commandKind: 'baseline.standardtime.define.v1',
      claimedAt: SEED_AT,
    });
    const provenance = baselineProvenance(operationId, 'baseline.standardtime.define.v1');
    const row = {
      id: seedUuid(`standard-time-${code}`),
      tenantId: TENANT,
      code,
      scope: 'process',
      targetCode: process.code,
      standardSeconds: process.standardMinutes * 60,
      preparationSeconds: process.preparationMinutes * 60,
      status: 'active',
      objectVersion: 1,
      auditStatus: 'unaudited',
      provenance,
      supersedes: null,
      businessTime: SEED_AT,
    };
    masterEvents.push(
      domainEvent({
        eventType: 'smes.baseline.v1.standard-time-defined',
        aggregateId: code,
        aggregateType: 'baseline-standard-time',
        aggregateRevision: 1,
        payload: { action: 'define', code, objectVersion: 1, status: 'active', supersedes: null, rowId: row.id },
        provenance,
        businessTime: SEED_AT_ISO,
      }),
    );
    return row;
  });

  const processes = await prisma.processDefRecord.createMany({ data: processRows, skipDuplicates: true });
  const routings = await prisma.routingRecord.createMany({ data: routingRows, skipDuplicates: true });
  const standardTimes = await prisma.standardTimeRecord.createMany({ data: standardTimeRows, skipDuplicates: true });

  // ── 4. 仓库 2（B3：直属库位+货架+货架库位；default + SMES_TENANTS）─────
  const tenants = seedTenants();
  const inventoryOperations = [];
  const warehouseCounts = [];
  for (const tenant of tenants) {
    const suffix = tenant === TENANT ? '' : `-${tenant}`;
    for (const [warehouseIndex, config] of FACTORY_WAREHOUSES.entries()) {
      const warehouseId = `${config.idBase}${suffix}`;
      inventoryOperations.push(
        operationRow(tenant, `seed-factory-${OP.warehouseOpsBase + warehouseIndex * 2}`, 'warehouse.define.v1', 'warehouse', warehouseId),
      );
      // upsert 空更新：既有同码仓（用户自建）不动；库位挂回读的实际仓 id。
      const warehouse = await prisma.warehouseRecord.upsert({
        where: { tenantId_code: { tenantId: tenant, code: config.code } },
        create: {
          id: warehouseId,
          tenantId: tenant,
          code: config.code,
          name: config.name,
          defaultLocationId: `${config.locationIdBase}-${config.locations[0].suffix}${suffix}`,
        },
        update: {},
      });
      for (const location of config.locations) {
        await prisma.warehouseLocationRecord.upsert({
          where: {
            tenantId_warehouseId_code: { tenantId: tenant, warehouseId: warehouse.id, code: location.code },
          },
          create: {
            id: `${config.locationIdBase}-${location.suffix}${suffix}`,
            tenantId: tenant,
            warehouseId: warehouse.id,
            code: location.code,
            name: location.name,
          },
          update: {},
        });
      }
      // 货架 + 货架库位（goods-shelf.define.v1 一命令建货架与下属库位；主数据无域事件）
      const shelfId = `${config.shelf.idBase}${suffix}`;
      inventoryOperations.push(
        operationRow(tenant, `seed-factory-${OP.warehouseOpsBase + warehouseIndex * 2 + 1}`, 'goods-shelf.define.v1', 'goods-shelf', shelfId),
      );
      const shelf = await prisma.goodsShelfRecord.upsert({
        where: { tenantId_warehouseId_code: { tenantId: tenant, warehouseId: warehouse.id, code: config.shelf.code } },
        create: {
          id: shelfId,
          tenantId: tenant,
          warehouseId: warehouse.id,
          code: config.shelf.code,
          name: config.shelf.name,
          remark: '工厂演示货架（seed-factory）',
          status: 'active',
          objectVersion: 1,
        },
        update: {},
      });
      for (const location of config.shelf.locations) {
        await prisma.shelfLocationRecord.upsert({
          where: { tenantId_code: { tenantId: tenant, code: location.code } },
          create: {
            id: `${config.shelf.locationIdBase}-${location.suffix}${suffix}`,
            tenantId: tenant,
            warehouseId: warehouse.id,
            goodsShelfId: shelf.id,
            code: location.code,
            name: location.name,
            remark: null,
            status: 'active',
            objectVersion: 1,
          },
          update: {},
        });
      }
      warehouseCounts.push(`${tenant}=${warehouse.id}/${config.code}`);
    }
  }
  const inventoryOps = await prisma.inventoryOperationRecord.createMany({ data: inventoryOperations, skipDuplicates: true });

  // ── 5. 在制链（default 租户；五单挂同一工作令）─────────────────────────
  const workOrderEvents = [];
  const machineEvents = [];
  const workorderOperations = [];
  const listingOperations = [];
  const dispatchOperations = [];
  const inspectionOperations = [];

  // 5a. 工作令 not_started@1（workorder.create.v1——初始态无机器事件）
  const workOrderRow = {
    id: WORK_ORDER_ID,
    tenantId: TENANT,
    flowConfigId: 'work-order',
    state: 'not_started',
    objectVersion: 1,
    customerRef: 'CUST-001',
    projectName: '工厂演示项目一（seed-factory）',
    salesRep: null,
    manager: ACTOR_PLAN,
    plannedDeliveryAt: PLANNED_DELIVERY_AT,
    packagingArrivalAt: PACKAGING_ARRIVAL_AT,
  };
  workorderOperations.push(operationRow(TENANT, OP.workorderCreate, 'workorder.create.v1', 'work-order', WORK_ORDER_ID));
  const workOrderCreatedEvent = domainEvent({
    eventType: 'smes.workorder.v1.created',
    aggregateId: WORK_ORDER_ID,
    aggregateType: 'work-order',
    aggregateRevision: 1,
    payload: {
      workOrderId: WORK_ORDER_ID,
      projectName: workOrderRow.projectName,
      customerRef: workOrderRow.customerRef,
      salesRep: null,
      manager: ACTOR_PLAN,
      plannedDeliveryAt: PLANNED_DELIVERY_AT.toISOString(),
      packagingArrivalAt: PACKAGING_ARRIVAL_AT.toISOString(),
      listingKinds: ['part', 'standard', 'electrical', 'equipment'],
      actor: ACTOR_PLAN,
    },
    provenance: moduleProvenance(OP.workorderCreate, 'workorder.create.v1', ACTOR_PLAN),
  });
  workOrderEvents.push(workOrderCreatedEvent);

  // 5b. 四类清单骨架（listing.import.v1 source=workorder——消费 WorkOrderCreated）
  const sheetRows = Object.entries(SHEET_IDS).map(([kind, sheetId]) => ({
    id: sheetId,
    tenantId: TENANT,
    workOrderId: WORK_ORDER_ID,
    kind,
    name: `${LISTING_KIND_LABELS[kind]}（${WORK_ORDER_ID}）`,
  }));
  listingOperations.push(operationRow(TENANT, OP.listingImportSkeleton, 'listing.import.v1', 'listing-sheet', SHEET_IDS.part));
  for (const [kind, sheetId] of Object.entries(SHEET_IDS)) {
    workOrderEvents.push(
      domainEvent({
        eventType: 'smes.listing.v1.listing-imported',
        aggregateId: sheetId,
        aggregateType: 'listing-sheet',
        aggregateRevision: 1,
        payload: {
          workOrderId: WORK_ORDER_ID,
          kind,
          sheetId,
          source: 'workorder',
          sourceEventId: workOrderCreatedEvent.eventId,
          previousLineCount: 0,
          importedLineCount: 0,
          rowIssues: [],
          actor: ACTOR_PLAN,
        },
        provenance: moduleProvenance(OP.listingImportSkeleton, 'listing.import.v1', ACTOR_PLAN),
      }),
    );
  }

  // 5c. 零件清单行导入（listing.import.v1 source=excel + 物料校验子命令）
  const partJudgments = PART_IMPORT_LINES.map((line) => {
    const item = FACTORY_ITEMS.find((entry) => entry.code === line.code);
    return {
      lineNo: line.lineNo,
      code: line.code,
      name: line.name,
      spec: line.spec,
      judgment: 'matched',
      candidateItemId: item.id,
      candidateItemCode: item.code,
      similarity: 1,
      basis: 'code-exact',
    };
  });
  const partSummary = { total: partJudgments.length, matched: partJudgments.length, suspected: 0, unmatched: 0 };
  const listingLineRows = PART_IMPORT_LINES.map((line) => {
    const judgment = partJudgments.find((entry) => entry.lineNo === line.lineNo);
    return {
      id: `ll-seed-factory-part-${line.lineNo}`,
      tenantId: TENANT,
      sheetId: SHEET_IDS.part,
      workOrderId: WORK_ORDER_ID,
      kind: 'part',
      lineNo: line.lineNo,
      drawingNo: line.drawingNo,
      code: line.code,
      name: line.name,
      spec: line.spec,
      itemId: judgment.candidateItemId,
      requiredQty: line.requiredQty,
      neededBy: NEEDED_BY_AT,
      validationStatus: 'matched',
      candidateItemId: judgment.candidateItemId,
      candidateItemCode: judgment.candidateItemCode,
      similarity: 1,
      basis: 'code-exact',
      source: 'excel',
    };
  });
  // 物料校验子命令（真实派生 operationId：<operationId>#material）
  const materialValidationProvenance = baselineProvenance(`${OP.listingImportPart}#material`, 'baseline.material.validate.v1');
  baselineOperations.push({
    tenantId: TENANT,
    operationId: `${OP.listingImportPart}#material`,
    commandKind: 'baseline.material.validate.v1',
    claimedAt: SEED_AT,
  });
  const materialValidationRun = {
    id: seedUuid('material-validation-part-import'),
    tenantId: TENANT,
    issuedBy: ACTOR_PLAN,
    summary: partSummary,
    lines: partJudgments,
    objectVersion: 1,
    auditStatus: 'unaudited',
    provenance: materialValidationProvenance,
    supersedes: null,
    businessTime: SEED_AT,
  };
  listingOperations.push(operationRow(TENANT, OP.listingImportPart, 'listing.import.v1', 'listing-sheet', SHEET_IDS.part));
  workOrderEvents.push(
    domainEvent({
      eventType: 'smes.baseline.v1.material-validated',
      aggregateId: materialValidationRun.id,
      aggregateType: 'baseline-material-validation',
      aggregateRevision: 1,
      payload: { runId: materialValidationRun.id, summary: partSummary, lines: partJudgments },
      provenance: materialValidationProvenance,
      businessTime: SEED_AT_ISO,
    }),
    domainEvent({
      eventType: 'smes.listing.v1.listing-imported',
      aggregateId: SHEET_IDS.part,
      aggregateType: 'listing-sheet',
      aggregateRevision: 1,
      payload: {
        workOrderId: WORK_ORDER_ID,
        kind: 'part',
        sheetId: SHEET_IDS.part,
        source: 'excel',
        sourceEventId: null,
        previousLineCount: 0,
        importedLineCount: listingLineRows.length,
        rowIssues: [],
        actor: ACTOR_PLAN,
      },
      provenance: moduleProvenance(OP.listingImportPart, 'listing.import.v1', ACTOR_PLAN),
    }),
    domainEvent({
      eventType: 'smes.listing.v1.listing-line-validated',
      aggregateId: SHEET_IDS.part,
      aggregateType: 'listing-sheet',
      aggregateRevision: 1,
      payload: {
        workOrderId: WORK_ORDER_ID,
        kind: 'part',
        sheetId: SHEET_IDS.part,
        summary: partSummary,
        lines: listingLineRows.map((line) => ({
          lineId: line.id,
          lineNo: line.lineNo,
          code: line.code,
          name: line.name,
          spec: line.spec,
          judgment: 'matched',
          candidateItemId: line.candidateItemId,
          candidateItemCode: line.candidateItemCode,
          similarity: 1,
          basis: 'code-exact',
        })),
        actor: ACTOR_PLAN,
      },
      provenance: moduleProvenance(OP.listingImportPart, 'listing.import.v1', ACTOR_PLAN),
    }),
  );

  // 5d. 采购订单 issued@4（submit→approve→issue 三命令链）
  const purchaseOrderRow = {
    id: PURCHASE_ORDER_ID,
    tenantId: TENANT,
    workOrderId: WORK_ORDER_ID,
    flowConfigId: 'purchase-order',
    state: 'issued',
    objectVersion: 4,
    supplierRef: 'SUP-001',
    supplierName: '演示供应商甲',
    promisedAt: PROMISED_AT,
    lines: PURCHASE_ORDER_LINES,
    requestIds: [],
    buyer: ACTOR_PURCH,
    remark: '工厂演示采购订单（seed-factory）',
    receiptRef: null,
  };
  listingOperations.push(
    operationRow(TENANT, OP.purchaseSubmit, 'purchase.order.submit.v1', 'purchase-order', PURCHASE_ORDER_ID),
    operationRow(TENANT, OP.purchaseApprove, 'purchase.order.approve.v1', 'purchase-order', PURCHASE_ORDER_ID),
    operationRow(TENANT, OP.purchaseIssue, 'purchase.order.issue.v1', 'purchase-order', PURCHASE_ORDER_ID),
  );
  machineEvents.push(
    machineEvent({
      flowId: 'purchase-order',
      eventAction: 'submitted',
      aggregateType: 'purchase-order',
      aggregateId: PURCHASE_ORDER_ID,
      revision: 2,
      from: 'draft',
      to: 'submitted',
      event: 'SUBMIT',
      reason: '采购订单提交',
      actor: ACTOR_PURCH,
    }),
    machineEvent({
      flowId: 'purchase-order',
      eventAction: 'approved',
      aggregateType: 'purchase-order',
      aggregateId: PURCHASE_ORDER_ID,
      revision: 3,
      from: 'submitted',
      to: 'approved',
      event: 'APPROVE',
      reason: '同意采购',
      actor: ACTOR_APPR,
      record: { reviewer: ACTOR_APPR, decision: 'approve', reason: '同意采购', evidence: [], objectVersion: 2, decidedAt: SEED_AT_ISO },
    }),
    machineEvent({
      flowId: 'purchase-order',
      eventAction: 'issued',
      aggregateType: 'purchase-order',
      aggregateId: PURCHASE_ORDER_ID,
      revision: 4,
      from: 'approved',
      to: 'issued',
      event: 'ISSUE',
      reason: '采购订单下发',
      actor: ACTOR_PURCH,
    }),
  );
  workOrderEvents.push(
    domainEvent({
      eventType: 'smes.listing.v1.purchase-order-submitted',
      aggregateId: PURCHASE_ORDER_ID,
      aggregateType: 'purchase-order',
      aggregateRevision: 2,
      payload: {
        workOrderId: WORK_ORDER_ID,
        supplierRef: 'SUP-001',
        supplierName: '演示供应商甲',
        promisedAt: PROMISED_AT_ISO,
        lines: PURCHASE_ORDER_LINES,
        requestIds: [],
        objectVersion: 2,
        actor: ACTOR_PURCH,
      },
      provenance: moduleProvenance(OP.purchaseSubmit, 'purchase.order.submit.v1', ACTOR_PURCH),
    }),
    domainEvent({
      eventType: 'smes.listing.v1.purchase-order-approved',
      aggregateId: PURCHASE_ORDER_ID,
      aggregateType: 'purchase-order',
      aggregateRevision: 3,
      payload: { remark: '同意采购', requestsApproved: [], objectVersion: 3, actor: ACTOR_APPR },
      provenance: moduleProvenance(OP.purchaseApprove, 'purchase.order.approve.v1', ACTOR_APPR),
    }),
    domainEvent({
      eventType: 'smes.listing.v1.purchase-order-issued',
      aggregateId: PURCHASE_ORDER_ID,
      aggregateType: 'purchase-order',
      aggregateRevision: 4,
      payload: { remark: '采购订单下发', requestsConverted: [], objectVersion: 4, actor: ACTOR_PURCH },
      provenance: moduleProvenance(OP.purchaseIssue, 'purchase.order.issue.v1', ACTOR_PURCH),
    }),
  );

  // 5e. 派工单 executing@3（create→assign→start；零件单带图号×工序）
  const dispatchRow = {
    id: DISPATCH_ID,
    tenantId: TENANT,
    workOrderId: WORK_ORDER_ID,
    kind: 'part',
    flowConfigId: 'dispatch-order',
    state: 'executing',
    objectVersion: 3,
    title: '零件派工：DWG-001 × OP-001',
    drawingNo: 'DWG-001',
    operationCode: 'OP-001',
    material: '圆钢 Φ60（演示）',
    sizeSpec: 'Φ60×300mm',
    quantity: 10,
    doneQty: 0,
    assignee: ACTOR_PROD,
    dueAt: DUE_AT,
    remark: '工厂演示派工单（seed-factory）',
  };
  dispatchOperations.push(
    operationRow(TENANT, OP.dispatchCreate, 'dispatch.create.v1', 'dispatch-order', DISPATCH_ID),
    operationRow(TENANT, OP.dispatchAssign, 'dispatch.assign.v1', 'dispatch-order', DISPATCH_ID),
    operationRow(TENANT, OP.dispatchStart, 'dispatch.start.v1', 'dispatch-order', DISPATCH_ID),
  );
  machineEvents.push(
    machineEvent({
      flowId: 'dispatch-order',
      eventAction: 'assigned',
      aggregateType: 'dispatch-order',
      aggregateId: DISPATCH_ID,
      revision: 2,
      from: 'draft',
      to: 'assigned',
      event: 'ASSIGN',
      reason: '派工到人',
      actor: ACTOR_PROD,
    }),
    machineEvent({
      flowId: 'dispatch-order',
      eventAction: 'started',
      aggregateType: 'dispatch-order',
      aggregateId: DISPATCH_ID,
      revision: 3,
      from: 'assigned',
      to: 'executing',
      event: 'START',
      reason: '开工',
      actor: ACTOR_PROD,
    }),
  );
  workOrderEvents.push(
    domainEvent({
      eventType: 'smes.dispatch.v1.dispatch-created',
      aggregateId: DISPATCH_ID,
      aggregateType: 'dispatch-order',
      aggregateRevision: 1,
      payload: {
        workOrderId: WORK_ORDER_ID,
        kind: 'part',
        title: dispatchRow.title,
        drawingNo: 'DWG-001',
        operationCode: 'OP-001',
        material: dispatchRow.material,
        sizeSpec: dispatchRow.sizeSpec,
        quantity: 10,
        dueAt: DUE_AT_ISO,
        kitCheck: null,
        outsourcingLines: [],
        objectVersion: 1,
        actor: ACTOR_PROD,
      },
      provenance: moduleProvenance(OP.dispatchCreate, 'dispatch.create.v1', ACTOR_PROD),
    }),
    domainEvent({
      eventType: 'smes.dispatch.v1.dispatch-assigned',
      aggregateId: DISPATCH_ID,
      aggregateType: 'dispatch-order',
      aggregateRevision: 2,
      payload: { assignee: ACTOR_PROD, remark: null, objectVersion: 2, actor: ACTOR_PROD },
      provenance: moduleProvenance(OP.dispatchAssign, 'dispatch.assign.v1', ACTOR_PROD),
    }),
    domainEvent({
      eventType: 'smes.dispatch.v1.dispatch-started',
      aggregateId: DISPATCH_ID,
      aggregateType: 'dispatch-order',
      aggregateRevision: 3,
      payload: {
        assignee: ACTOR_PROD,
        progress: {
          stage: 'machining',
          drawingNo: 'DWG-001',
          operationId: 'OP-001',
          doneQty: 0,
          totalQty: 10,
          status: 'in_progress',
        },
        objectVersion: 3,
        actor: ACTOR_PROD,
      },
      provenance: moduleProvenance(OP.dispatchStart, 'dispatch.start.v1', ACTOR_PROD),
    }),
  );

  // 5f. 质检单 pending@1（inspection.create.v1 手工建单——初始态无机器事件）
  const inspectionRow = {
    id: INSPECTION_ID,
    tenantId: TENANT,
    flowConfigId: 'inspection-order',
    state: 'pending',
    objectVersion: 1,
    kind: 'self_outsourced',
    sourceType: null,
    sourceRefId: null,
    itemId: null,
    drawingNo: 'DWG-001',
    quantity: 10,
  };
  inspectionOperations.push(operationRow(TENANT, OP.inspectionCreate, 'inspection.create.v1', 'inspection-order', INSPECTION_ID));
  workOrderEvents.push(
    domainEvent({
      eventType: 'smes.inspection.v1.created',
      aggregateId: INSPECTION_ID,
      aggregateType: 'inspection-order',
      aggregateRevision: 1,
      payload: {
        inspectionId: INSPECTION_ID,
        kind: 'self_outsourced',
        sourceType: null,
        sourceRefId: null,
        itemId: null,
        drawingNo: 'DWG-001',
        quantity: 10,
        actor: ACTOR_QC,
      },
      provenance: moduleProvenance(OP.inspectionCreate, 'inspection.create.v1', ACTOR_QC),
    }),
  );

  // ── 6. 在制链落库（顺序：投影 → 机器事件 → 域事件 → outbox → 账本）──
  // 机器事件账本前置（PG 适配按投影行解析租户——投影先落）；outbox 有
  // event_records 外键——事件先落。
  const workOrders = await prisma.workOrderProjectionRecord.createMany({ data: [workOrderRow], skipDuplicates: true });
  const sheets = await prisma.listingSheetRecord.createMany({ data: sheetRows, skipDuplicates: true });
  const listingLines = await prisma.listingLineRecord.createMany({ data: listingLineRows, skipDuplicates: true });
  const purchaseOrders = await prisma.purchaseOrderRecord.createMany({ data: [purchaseOrderRow], skipDuplicates: true });
  const dispatchOrders = await prisma.dispatchOrderRecord.createMany({ data: [dispatchRow], skipDuplicates: true });
  const inspections = await prisma.inspectionOrderRecord.createMany({ data: [inspectionRow], skipDuplicates: true });
  const materialRuns = await prisma.materialValidationRunRecord.createMany({ data: [materialValidationRun], skipDuplicates: true });

  const listingMachineEvents = machineEvents.filter((event) => event.aggregateType === 'purchase-order');
  const dispatchMachineEvents = machineEvents.filter((event) => event.aggregateType === 'dispatch-order');
  await prisma.listingEventRecord.createMany({ data: listingMachineEvents, skipDuplicates: true });
  await prisma.dispatchEventRecord.createMany({ data: dispatchMachineEvents, skipDuplicates: true });

  const allDomainEvents = [...masterEvents, ...workOrderEvents];
  const eventsInserted = await prisma.businessEventRecord.createMany({ data: allDomainEvents, skipDuplicates: true });
  const outboxRows = allDomainEvents.map((event) => ({ eventId: event.eventId, tenantId: event.tenantId, createdAt: SEED_AT }));
  await prisma.outboxRecord.createMany({ data: outboxRows, skipDuplicates: true });

  const workorderOps = await prisma.workorderOperationRecord.createMany({ data: workorderOperations, skipDuplicates: true });
  const listingOps = await prisma.listingOperationRecord.createMany({ data: listingOperations, skipDuplicates: true });
  const dispatchOps = await prisma.dispatchOperationRecord.createMany({ data: dispatchOperations, skipDuplicates: true });
  const inspectionOps = await prisma.inspectionOperationRecord.createMany({ data: inspectionOperations, skipDuplicates: true });
  const baselineOps = await prisma.baselineOperationRecord.createMany({ data: baselineOperations, skipDuplicates: true });

  console.log(
    `seed-factory 完成（幂等）：users +${users.count}，policies +${policies.count}` +
      `，customers +${customers.count}，suppliers +${suppliers.count}，items +${items.count}` +
      `，processes +${processes.count}，routings +${routings.count}，standard_times +${standardTimes.count}` +
      `，baseline_operations +${baselineOps.count}，inventory_operations +${inventoryOps.count}` +
      `，仓库 ${warehouseCounts.join(', ')}` +
      `，在制链：work_orders +${workOrders.count}，sheets +${sheets.count}，lines +${listingLines.count}` +
      `，material_runs +${materialRuns.count}，purchase_orders +${purchaseOrders.count}` +
      `，dispatch_orders +${dispatchOrders.count}，inspections +${inspections.count}` +
      `，机器事件 ${listingMachineEvents.length + dispatchMachineEvents.length} 条` +
      `，域事件+outbox +${eventsInserted.count}/+${allDomainEvents.length}` +
      `，账本 wo+${workorderOps.count}/listing+${listingOps.count}/dispatch+${dispatchOps.count}/insp+${inspectionOps.count}` +
      `（wo=${WORK_ORDER_ID}）`,
  );
}

// 直跑入口（pnpm db:seed-factory = node prisma/seed-factory.mjs）：env 门在
// PrismaClient 实例化之前（无 DB 环境也能给出明确提示，spawn 可验证）；
// realpath 比对防符号链接误判，被测试 import（argv[1] = vitest bin）不触发。
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.env['SMES_FACTORY_SEED'] !== FACTORY_SEED_ENV_SWITCH) {
    console.error(
      `seed-factory 未执行：需 SMES_FACTORY_SEED=${FACTORY_SEED_ENV_SWITCH}（显式门——缺省不跑，防误触工厂夹具数据）。` +
        `用法：SMES_FACTORY_SEED=on pnpm --filter @smes/business-store run db:seed-factory`,
    );
    process.exitCode = 1;
  } else {
    const prisma = new PrismaClient();
    seedFactoryMain(prisma)
      .catch((error) => {
        console.error('seed-factory 失败:', error);
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}
