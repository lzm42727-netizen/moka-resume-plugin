/**
 * 本地私有配置模板（复制为 config.local.js 后按需修改）
 *
 * config.local.js 已在 .gitignore 中，不会入库。
 * 行为（1.10.0）：接口协议 / API 提供商 / Endpoint / 模型名称会被**锁定**——设置页收成一条只读
 *               「部署摘要」，不让误改；API Key 是唯一需要招聘者填写的内容。
 *               评分并发 / 强制 JSON / 费用单价不在锁定范围，设置页「高级」里仍可改。
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
