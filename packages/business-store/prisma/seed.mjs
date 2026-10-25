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
 *
 * 口令（M1 收尾波-③ 真实认证）：全部种子身份默认口令 = demo-password
 * （明文写在此注释与下方常量——种子演示环境，非生产凭据；口令策略/改密
 * 流程是非目标）。哈希走与 application/src/auth/password.ts 同一 scrypt
 * 自述格式（scrypt$N$r$p$salt$hash，N=16384/r=8/p=1/keylen=64）——种子脚本
 * 不引 dist，参数内联钉死（同 ruleKey 先例）；每次种子随机盐。
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT = 'default';

/** 种子演示环境默认口令（写明：demo-password）。 */
const DEFAULT_SEED_PASSWORD = 'demo-password';

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('hex'), hash.toString('hex')].join('$');
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

async function main() {
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
  console.log(
    `seed 完成：users +${users.count}（幂等跳过已存在），policies +${policies.count}（tenant '${TENANT}'）`,
  );
}

main()
  .catch((error) => {
    console.error('seed 失败:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
