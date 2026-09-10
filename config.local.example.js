/**
 * 本地私有配置模板（复制为 config.local.js 后按需修改）
 *
 * config.local.js 已在 .gitignore 中，不会入库。
 * 行为：接口协议 / API 提供商 / Endpoint 会被**锁定**（设置页置灰，不可误改）；
 *       模型名称只作默认值兜底，设置页可随时修改；API Key 仍走设置页输入。
 *
 * 用法：
 *   cp config.local.example.js config.local.js
 */
(function (g) {
  g.MOKA_LOCAL_SETTINGS = {
    apiProtocol: 'openai', // openai（兼容 /chat/completions） | claude（/v1/messages）
    apiProvider: '自建 / 中转网关', // 仅作标签，可自由填写
    apiEndpoint: 'https://your-gateway.example.com/v1',
    modelName: 'your-model-name'
  };
})(typeof self !== 'undefined' ? self : window);
