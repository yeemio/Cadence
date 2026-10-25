/**
 * listing 工序×原材料关联 id 生成（U4；体例同 listing-ids——前缀 + uuidv7，
 * 复用该文件的模块内 uuidv7 实现，不另起生成器）。
 */
import { uuidv7 } from './listing-ids.js';

/** 工序×原材料关联行 id：ppm-<uuidv7>（对应原文表缩写 pppm）。 */
export function newProcessMaterialLinkId(): string {
  return `ppm-${uuidv7()}`;
}
