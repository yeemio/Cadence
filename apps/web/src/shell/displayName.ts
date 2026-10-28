/**
 * 顶栏显示名呈现净化（UX-PLAN-13 / UX-AP-06 / UX-VW-02）：会话 displayName
 * 来自服务端种子（prisma/seed.mjs），夹具注释后缀与权限码拼接会原样上顶栏
 * （「演示管理员（Web 登录流）」「种子审批人（approval:read/write）」「种子访客
 * （无策略）」）。服务端种子与 packages 本批不可改——净化收敛在本呈现层文件
 * （组件级，不碰侧栏菜单注册，规避 W6 撞车）。
 *
 * 规则（只剥呈现，不改会话存储）：
 *  1. 剥尾部括注：内容为权限码形（ASCII `word:word/word` 等）或已知夹具注释
 *     （无策略 / Web 登录流）时剥掉；业务性括注（如「张三（车间主任）」）保留；
 *  2. 夹具前缀「种子」→「演示」：与登录页「演示账号」口径一致（去夹具词，
 *     不臆造新身份名）；
 *  3. 全半角括号都认；净化结果为空时原样返回（调用方另有 fallbackName 兜底）。
 */

/** 已知夹具注释（种子 displayName 尾部括注；业务括注不在此列）。 */
const FIXTURE_ANNOTATIONS: ReadonlySet<string> = new Set(['无策略', 'Web 登录流']);

/** 尾部括注（全/半角，不跨层嵌套）。 */
const TRAILING_ANNOTATION_RE = /[（(]([^（）()]*)[)）]\s*$/;

/** 权限码形内容（ASCII 词 + : / + . - 等，如 approval:read/write、*）。 */
const CODE_LIKE_RE = /^[\w.:+*/-]+$/;

export function presentDisplayName(raw: string): string {
  let name = raw.trim();
  const annotation = TRAILING_ANNOTATION_RE.exec(name);
  if (annotation !== null) {
    const inner = annotation[1] ?? '';
    if (CODE_LIKE_RE.test(inner) || FIXTURE_ANNOTATIONS.has(inner)) {
      name = name.slice(0, annotation.index).trim();
    }
  }
  if (name.startsWith('种子')) {
    name = `演示${name.slice(2)}`;
  }
  return name.length > 0 ? name : raw.trim();
}
