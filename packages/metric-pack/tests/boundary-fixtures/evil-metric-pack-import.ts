/**
 * 边界铁律自检夹具：故意从专业包违规引用 application（pro-pack-tier-edges）。
 * 被主配置 exclude（boundary-fixtures）；由 selftest 单独扫描证明规则真实生效。
 */
import { APPLICATION_PLACEHOLDER } from '../../../application/src/index';

export const EVIL_METRIC_PACK_IMPORT = APPLICATION_PLACEHOLDER;
