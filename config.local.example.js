/**
 * 本地私有配置模板（复制为 config.local.js 后按需修改）
 *
 * config.local.js 已在 .gitignore 中，不会入库。
 * 这里只是「默认值兜底」：设置页里没填的项用它，填过的以设置页为准，
 * 界面不会被锁定、也不会被覆盖（1.9.0 起）。
 * 优先级：内置默认 < 本文件 < 设置页保存的值。API Key 仍走设置页输入。
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
