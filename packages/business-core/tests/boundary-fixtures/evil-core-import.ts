/**
 * 边界铁律自检夹具：故意从 business-core 违规引用 application（core-no-internal-deps）。
 *
 * - 只被 scripts/boundary-selftest.mjs 经 .dep-cruiser.selftest.cjs 扫描
 * - 被主 boundary 扫描忽略（.dep-cruiser.cjs options.ignore）
 * - 被 tsconfig 排除、无 .test 后缀故 vitest 不收录
 */
import { APPLICATION_PLACEHOLDER } from '../../../application/src/index';

export const EVIL_CORE_IMPORT = APPLICATION_PLACEHOLDER;
