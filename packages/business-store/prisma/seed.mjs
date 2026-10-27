/**
 * 组织种子（M1 增量 3-D）：默认租户的管理员策略 + 演示身份授权。幂等可重跑。
 *
 * 方式取舍：显式迁移后种子（pnpm db:seed / node prisma/seed.mjs），不做启动期
 * 种子——"bootstrap 阶段不碰数据库"是硬合同（启动零 DB 依赖，H 线 boot smoke
 * 依赖此性质）；便利性让位于该合同。
 *
 * 内容（词汇纪律 ADR-0010，全通用词）：
 *   - user-seed-admin    → default 租户 admin 角色（域内 bypass）
 *   - user-seed-viewer   → 无任何策略（e2e 的 403 证据身份）
 *   - user-demo-admin    → default 租户 admin（Web 演示管理员，真实登录流同款）
 *   - user-seed-approver → default 租户 approver 角色（M1 收尾波-① 审批演示
 *     策略：approval:read/write + workbench:read——可发起/决策并看到自己的
 *     审批待办计数；无 admin bypass，走 casbin 精确授权路径）
 *   - 默认收货仓（D-15，D-16 升级为按租户建）：每租户 code=MAIN 默认仓 +
 *     默认库位 MAIN-01——采购收货未显式指定 warehouseId 且 env
 *     SMES_DEFAULT_WAREHOUSE_CODE 配了 MAIN（compose 缺省）时，inventory
 *     命令期在租户内按 (tenant, code) 解析开箱兜底（演示/测试栈）。租户
 *     清单 = default 恒种 + env SMES_TENANTS（与 server 已知租户同源；单机
 *     缺省空清单 = 只种 default，行为不变）。取舍（写明）：不做"唯一启用仓"
 *     自动回落——warehouse 模型无启用位且回落判定属 inventory 服务；各租户
 *     MAIN 仓 id 不同（default=wh-seed-main，其余 wh-seed-main-<tenant>），
 *     env 用 code 而非 id 引用正是为此（全局单值 id 只能命中一个租户）。
 *
 * 口令（M1 收尾波-③ 真实认证；M2 安全前置批 SP-2 同批升档）：全部种子身份
 * 默认口令 = demo-password（明文写在此注释与下方常量——种子演示环境，非生产
 * 凭据；13 字符 ≥ SP-4 缺省下限 8，无需调整）。哈希走与
 * application/src/auth/password.ts 同一 scrypt 自述格式
 * （scrypt$N$r$p$salt$hash，N=65536/r=8/p=1/keylen=64 + maxmem 128MiB——
 * SP-2 同批升档，同格式同源）——种子脚本不引 dist，参数内联钉死（同
 * ruleKey 先例）；每次种子随机盐。
 *
 * 可测形状（D-15）：主逻辑收在 seedMain(prisma) 导出（PrismaClient 由调用方
 * 注入——tests/seed.test.ts 用内存桩锚定幂等）；直跑入口用 argv[1] realpath
 * 判断，被测试 import 时不触发副作用。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const TENANT = 'default';

/** 种子演示环境默认口令（写明：demo-password）。 */
const DEFAULT_SEED_PASSWORD = 'demo-password';

/** D-15/D-16 默认收货仓（code=MAIN；default 固定 id 沿用 wh-seed-main 既有锚）。 */
const WAREHOUSE_CODE = 'MAIN';
const WAREHOUSE_NAME = '默认仓（种子）';
const LOCATION_CODE = 'MAIN-01';
const LOCATION_NAME = '默认库位（种子）';

/**
 * 种子租户清单（D-16）：default 恒种 + env SMES_TENANTS（SaaS 已知租户逗号
 * 清单，与 server hostBased 解析同源——migrate 服务在 compose 同名透传）；
 * 去重去空。身份/策略仍只种 default（租户开通流程属 M4 后续波，见 deploy/README）。
 */
function seedTenants() {
  const extra = (process.env['SMES_TENANTS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== TENANT);
  return [TENANT, ...extra];
}

/** 各租户固定 id 方案（幂等锚 + 可诊断）：default 沿用 wh-seed-main；其余 wh-seed-main-<tenant>。 */
function warehouseIdFor(tenant) {
  return tenant === TENANT ? 'wh-seed-main' : `wh-seed-main-${tenant}`;
}

function locationIdFor(tenant) {
  return tenant === TENANT ? 'loc-seed-main' : `loc-seed-main-${tenant}`;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  // SP-2 同批升档：N=65536（2^16）+ maxmem 128MiB（64MiB 需求超 node 缺省 32MiB，
  // 不显式传 maxmem 则 scryptSync 直接抛错）——与 application password.ts 同源同格式。
  const hash = scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', 65536, 8, 1, salt.toString('hex'), hash.toString('hex')].join('$');
}

/** 与 src/org/policy-mapping.ts 的 policyRuleKey 同形状（种子脚本不引 dist，内联钉死）。 */
function ruleKey(rule) {
  return rule.kind === 'grant-role'
    ? `grant-role|${rule.tenant}|${rule.user}|${rule.role}`
    : `grant-permission|${rule.tenant}|${rule.role}|${rule.resource}|${rule.action}`;
}

const seedUsers = [
  { id: 'user-seed-admin', username: 'admin', displayName: '种子管理员' },
  { id: 'user-seed-viewer', username: 'viewer', displayName: '种子访客（无策略）' },
  { id: 'user-demo-admin', username: 'demo-admin', displayName: '演示管理员（Web 登录流）' },
  { id: 'user-seed-approver', username: 'approver', displayName: '种子审批人（approval:read/write）' },
];

const seedPolicies = [
  { kind: 'grant-role', tenant: TENANT, user: 'user-seed-admin', role: 'admin' },
  { kind: 'grant-role', tenant: TENANT, user: 'user-demo-admin', role: 'admin' },
  // 审批演示策略（M1 收尾波-①）：approver 角色 = 精确权限码，无 bypass
  { kind: 'grant-role', tenant: TENANT, user: 'user-seed-approver', role: 'approver' },
  { kind: 'grant-permission', tenant: TENANT, role: 'approver', resource: 'approval', action: 'read' },
  { kind: 'grant-permission', tenant: TENANT, role: 'approver', resource: 'approval', action: 'write' },
  { kind: 'grant-permission', tenant: TENANT, role: 'approver', resource: 'workbench', action: 'read' },
];

function policyToRow(rule) {
  return {
    ruleKey: ruleKey(rule),
    tenantId: rule.tenant,
    kind: rule.kind,
    userId: rule.kind === 'grant-role' ? rule.user : null,
    role: rule.role,
    resource: rule.kind === 'grant-permission' ? rule.resource : null,
    action: rule.kind === 'grant-permission' ? rule.action : null,
  };
}

/**
 * 种子主逻辑（幂等）：users/policies 走 createMany skipDuplicates；每租户
 * 默认仓走 upsert（(tenant, code) / (tenant, warehouse, code) 复合唯一键，
 * update 空对象——重跑不重复、不动既有 MAIN 仓的任何字段）。
 */
export async function seedMain(prisma) {
  const users = await prisma.userRecord.createMany({
    data: seedUsers.map((user) => ({
      ...user,
      tenantId: TENANT,
      active: true,
      passwordHash: hashPassword(DEFAULT_SEED_PASSWORD),
    })),
    skipDuplicates: true,
  });
  const policies = await prisma.policyRecord.createMany({
    data: seedPolicies.map(policyToRow),
    skipDuplicates: true,
  });
  const warehouses = [];
  for (const tenant of seedTenants()) {
    const warehouse = await prisma.warehouseRecord.upsert({
      where: { tenantId_code: { tenantId: tenant, code: WAREHOUSE_CODE } },
      create: {
        id: warehouseIdFor(tenant),
        tenantId: tenant,
        code: WAREHOUSE_CODE,
        name: WAREHOUSE_NAME,
        defaultLocationId: locationIdFor(tenant),
      },
      update: {},
    });
    // 库位挂在 upsert 回读的实际仓 id 下（既有 MAIN 仓非种子建时不误挂固定 id）。
    await prisma.warehouseLocationRecord.upsert({
      where: {
        tenantId_warehouseId_code: { tenantId: tenant, warehouseId: warehouse.id, code: LOCATION_CODE },
      },
      create: {
        id: locationIdFor(tenant),
        tenantId: tenant,
        warehouseId: warehouse.id,
        code: LOCATION_CODE,
        name: LOCATION_NAME,
      },
      update: {},
    });
    warehouses.push(warehouse);
  }
  console.log(
    `seed 完成：users +${users.count}（幂等跳过已存在），policies +${policies.count}` +
      `（tenant '${TENANT}'），默认仓 ${warehouses.map((w) => `${w.tenantId}=${w.id}/${WAREHOUSE_CODE}`).join(', ')}（每租户幂等）`,
  );
}

// 直跑入口（pnpm db:seed = node prisma/seed.mjs）：realpath 比对防符号链接
// 误判；被测试 import（argv[1] = vitest bin）不触发。
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const prisma = new PrismaClient();
  seedMain(prisma)
    .catch((error) => {
      console.error('seed 失败:', error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
