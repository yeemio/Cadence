/**
 * 边界铁律自检夹具：故意从引擎包违规引用 application（engine-tier-edges，ADR-0011 收紧后）。
 */
import { APPLICATION_PLACEHOLDER } from '../../../application/src/index';

export const EVIL_ENGINE_IMPORT = APPLICATION_PLACEHOLDER;
