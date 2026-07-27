/**
 * 本地私有配置模板（复制为 config.local.js 后按需修改）
 *
 * config.local.js 已在 .gitignore 中，不会入库。
 * 这里的值会强制覆盖插件设置里的「API 提供商 / Endpoint / 模型名称」，
 * 并在弹窗中锁定这三项。API Key 仍走正常设置输入。
 *
 * 用法：
 *   cp config.local.example.js config.local.js
 */
(function (g) {
  g.MOKA_LOCAL_SETTINGS = {
    apiProvider: 'custom', // openai | claude | custom
    apiEndpoint: 'https://your-gateway.example.com/v1',
    modelName: 'your-model-name'
  };
})(typeof self !== 'undefined' ? self : window);
