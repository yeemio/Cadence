/**
 * casbin 域模型文本（RBAC with domains，入库版本化）。
 *
 * 语义三约束（M1 增量 2-B 合同）：
 *  1. 租户维度隔离：`dom` 同时出现在请求、g 绑定与 p 授权三元组里，
 *     t1 内的角色绑定/权限授予对 t2 全部不成立；
 *  2. 精确匹配不放宽：matcher 零通配符（无 keyMatch、无 `*`），
 *     授予 demo:read 不会旁通 demo:write 或任何相邻权限码；
 *  3. admin bypass 不在 matcher 里：见 PermissionService——按"域内角色含 admin
 *     即放行"在业务层判定，admin 身份同样不跨租户。
 *
 * 版本纪律：模型文本是行为合同，改动 = 新版本常量 + 迁移说明，不原地改语义。
 * 形状来源：casbin 官方 rbac_with_domains 模型约定（Apache-2.0），本文本为本仓措辞。
 */
export const AUTHORIZATION_MODEL_VERSION = 'v1' as const;

export const AUTHORIZATION_MODEL_V1 = `# smes.authorization.model ${AUTHORIZATION_MODEL_VERSION}
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
`;

/** 当前生效的授权模型文本（版本化常量，禁止原地修改语义）。 */
export const AUTHORIZATION_MODEL: string = AUTHORIZATION_MODEL_V1;

/** 内置管理角色：域内持有即全量放行（bypass 语义见 PermissionService）。 */
export const ADMIN_ROLE = 'admin';
