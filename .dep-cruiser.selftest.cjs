/** 铁律自检配置：与主配置同规则，但不忽略故意违规夹具（boundary-fixtures）。 */
const base = require('./.dep-cruiser.cjs');

module.exports = {
  ...base,
  options: { ...base.options, exclude: { path: '\\.d\\.ts$' } },
};
