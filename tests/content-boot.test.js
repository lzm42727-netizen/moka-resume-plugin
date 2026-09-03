/**
 * content.js 顶层加载冒烟测试。
 *
 * 防的是这类事故：init() 在模块级 let/const 初始化完成前被调用，命中 TDZ
 * 抛错后顶层脚本中断，后半段声明（如 publishTimer）永远处于未初始化状态，
 * 运行时才以「Cannot access 'X' before initialization」暴露出来。
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const messageListeners = [];
const intervals = [];
let contentApi;

function installStubs() {
  const listeners = {};
  globalThis.location = {
    href: 'https://app.mokahr.com/candidates?pipelineId=123&jobIds=job-1',
    origin: 'https://app.mokahr.com',
    pathname: '/candidates',
    search: '?pipelineId=123&jobIds=job-1',
    hash: ''
  };
  globalThis.window = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage: () => {},
    location: globalThis.location
  };
  globalThis.document = {
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  const emptyStore = {
    get: (_keys, cb) => { if (typeof cb === 'function') cb({}); },
    set: (_obj, cb) => { if (typeof cb === 'function') cb(); },
    remove: (_keys, cb) => { if (typeof cb === 'function') cb(); }
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: (_msg, cb) => {
        if (typeof cb === 'function') { cb(undefined); return undefined; }
        return Promise.resolve(undefined);
      }
    },
    storage: { local: emptyStore }
  };
  globalThis.sessionStorage = { length: 0, key: () => null, getItem: () => null };
  globalThis.localStorage = globalThis.sessionStorage;
  // 不真的排期，避免测试进程被 content.js 的轮询定时器挂住
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  globalThis.clearInterval = () => {};
  // 本测试只关心「顶层能否跑完」，不发真实请求
  globalThis.fetch = () => Promise.reject(new Error('stubbed fetch'));
}

describe('content.js 顶层加载', () => {
  before(() => {
    installStubs();
    require('../lib/score.js');
    require('../lib/capture.js');
    require('../lib/persist.js');
    require('../lib/feedback.js');
    require('../lib/screening-job.js');
    require('../lib/moka-actions.js');
    require('../lib/match.js');
    contentApi = require('../content.js');
  });

  it('不抛异常地跑完整个顶层脚本', () => {
    assert.ok(contentApi);
  });

  it('init() 已注册消息监听（脚本没有中途中断）', () => {
    assert.equal(messageListeners.length, 1);
  });

  it('顶层执行到文件末尾：末尾声明的绑定可用', () => {
    // publishResults 依赖文件末尾的 publishTimer；顶层若中断，这里会抛 TDZ
    const listener = messageListeners[0];
    let replied = null;
    listener({ action: 'ping' }, {}, (resp) => { replied = resp; });
    assert.deepEqual(replied, { ok: true });

    let started = null;
    listener(
      { action: 'startScreening', jobId: 'job-1', jobType: 'intern', weights: {}, force: true },
      {},
      (resp) => { started = resp; }
    );
    assert.ok(started, 'startScreening 必须同步回包，否则侧栏只会看到「无法连接页面」');
    assert.equal(started.ok, true);
  });

  it('已配置的结构化门槛在简历缺少对应字段时判为未过', () => {
    const result = contentApi.evaluateHardConditions(
      { highestDegree: '', intelligentTags: [], gender: '', age: null, experience: 0 },
      {
        degree: '本科',
        gender: '女',
        ageRanges: [{ min: 20, max: 25, label: '20-25' }]
      },
      'full-time'
    );
    assert.deepEqual(result.missing, [
      '学历需本科及以上',
      '性别需女',
      '年龄需 20-25'
    ]);
  });
});
