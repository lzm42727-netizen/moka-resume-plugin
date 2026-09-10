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
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
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
    get: (_keys, cb) => {
      if (typeof cb === 'function') cb({});
    },
    set: (_obj, cb) => {
      if (typeof cb === 'function') cb();
    },
    remove: (_keys, cb) => {
      if (typeof cb === 'function') cb();
    }
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: (_msg, cb) => {
        if (typeof cb === 'function') {
          cb(undefined);
          return undefined;
        }
        return Promise.resolve(undefined);
      }
    },
    storage: { local: emptyStore }
  };
  globalThis.sessionStorage = { length: 0, key: () => null, getItem: () => null };
  globalThis.localStorage = globalThis.sessionStorage;
  // 不真的排期，避免测试进程被 content.js 的轮询定时器挂住
  globalThis.setInterval = (fn) => {
    intervals.push(fn);
    return intervals.length;
  };
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
    require('../lib/usage.js');
    require('../lib/moka-actions.js');
    require('../lib/match.js');
    require('../lib/candidate-profile.js');
    require('../lib/contracts.js');
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
    listener({ action: 'ping' }, {}, (resp) => {
      replied = resp;
    });
    assert.deepEqual(replied, { ok: true });

    let started = null;
    listener(
      { action: 'startScreening', jobId: 'job-1', jobType: 'intern', weights: {}, force: true },
      {},
      (resp) => {
        started = resp;
      }
    );
    assert.ok(started, 'startScreening 必须同步回包，否则侧栏只会看到「无法连接页面」');
    assert.equal(started.ok, true);
  });

  it('侧栏所选职位与页面职位不一致时，getJobSpec 拒绝解读而不是读回上一个岗的 JD', async () => {
    // 页面停在 job-1 的列表，侧栏却选了 job-2：此时抓到的 JD 属于 job-1，
    // 一旦解读成功就会把上一个岗的理解与门槛写进 job-2 并落盘。
    const listener = messageListeners[0];
    const resp = await new Promise((resolve) => {
      listener({ action: 'getJobSpec', jobType: 'full-time', jobId: 'job-2' }, {}, resolve);
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.spec, null);
    assert.match(resp.error, /职位/);
  });

  it('同一个职位不受影响，仍按正常路径去抓 JD', async () => {
    const listener = messageListeners[0];
    const resp = await new Promise((resolve) => {
      listener({ action: 'getJobSpec', jobType: 'full-time', jobId: 'job-1' }, {}, resolve);
    });
    // 测试环境 fetch 被打桩，这里只要求它不是「串岗」这条错
    assert.equal(resp.ok, false);
    assert.doesNotMatch(resp.error, /另一个职位/);
  });

  it('简历缺少对应字段时判为待确认（unknown），不误判为未过', () => {
    const result = contentApi.evaluateHardConditions(
      { highestDegree: '', intelligentTags: [], gender: '', age: null, experience: 0 },
      {
        degree: '本科',
        gender: '女',
        ageRanges: [{ min: 20, max: 25, label: '20-25' }]
      },
      'full-time'
    );
    // 空字段 = 简历里没写，无法判定，归入 unknown；不能算作硬性不符而直接淘汰
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unknown, ['学历需本科及以上', '性别需女', '年龄需 20-25']);
  });

  it('isOnCandidatePage 精确匹配 application id，前缀撞车不算同页', () => {
    const originalPathname = globalThis.location.pathname;
    try {
      globalThis.location.pathname = '/candidates/application/8147011850';
      // 目标 id 是当前 URL id 的前缀：旧 indexOf 写法会误判「已在目标页」，在错误候选人身上点按钮
      assert.equal(contentApi.isOnCandidatePage('814701185'), false);
      assert.equal(contentApi.isOnCandidatePage('8147011850'), true);
      globalThis.location.pathname = '/candidates/application/814701185?scene=x';
      assert.equal(contentApi.isOnCandidatePage('814701185'), true);
    } finally {
      globalThis.location.pathname = originalPathname;
    }
  });

  it('markDetailAppSeen 记录 application id 与候选人姓名，供点击前身份校验', () => {
    contentApi.markDetailAppSeen(
      'https://app.mokahr.com/api/applications/814701185?scene=x',
      JSON.stringify({ code: 0, data: { id: 814701185, name: '王歆澄' } })
    );
    // 仅有请求没有响应体时，保留已有姓名不覆盖为空
    contentApi.markDetailAppSeen('https://app.mokahr.com/api/applications/814701185');
    const seen = contentApi.detailSeenAppsForTest();
    assert.ok(seen['814701185'], '应记录 application id');
    assert.equal(seen['814701185'].name, '王歆澄');
  });

  it('harvestMemberNames 从组织类接口收割分配对象的 id→姓名', () => {
    const json = JSON.stringify({
      code: 0,
      data: {
        list: [
          { id: 6397518, name: '王歆澄' },
          { id: 8981545, userName: '宁子腾' },
          { id: 123, name: 'id 太小不收' },
          { id: 99000001, name: '' },
          { name: '没有 id 不收' }
        ]
      }
    });
    assert.equal(
      contentApi.harvestMemberNames('https://app.mokahr.com/api/outer/ats-employee/search', json),
      2
    );
    const names = contentApi.memberNamesForTest();
    assert.equal(names['6397518'], '王歆澄');
    assert.equal(names['8981545'], '宁子腾');
  });

  it('harvestMemberNames 跳过候选人与详情接口，防止把候选人姓名记成成员', () => {
    const json = JSON.stringify({ data: { id: 63000001, name: '候选某人' } });
    assert.equal(
      contentApi.harvestMemberNames('https://app.mokahr.com/api/outer/ats-candidate/search-candidate/v2', json),
      0
    );
    assert.equal(
      contentApi.harvestMemberNames('https://app.mokahr.com/api/applications/814701185', json),
      0
    );
    assert.ok(!contentApi.memberNamesForTest()['63000001']);
  });

  it('validAssigneeNames 只在弹窗名字数与分配 id 数一致时采信', () => {
    // 弹窗芯片与 id 无顺序对应，只作为整组展示；数量对不上宁可退回「N 人」
    assert.deepEqual(contentApi.validAssigneeNames(['高玉宝', '贾舒尧', '高玉宝'], 2), ['高玉宝', '贾舒尧']);
    assert.deepEqual(contentApi.validAssigneeNames(['高玉宝'], 2), []);
    assert.deepEqual(contentApi.validAssigneeNames(null, 2), []);
    assert.deepEqual(contentApi.validAssigneeNames(['这是个超长名字超过了十二个字符限制吧'], 1), []);
    assert.deepEqual(contentApi.validAssigneeNames(['王歆澄'], 1), ['王歆澄']);
  });
});
