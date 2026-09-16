const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Feishu = require('../lib/feishu.js');

describe('Feishu 卡片组装与协议契约', () => {
  it('正确构造候选人卡片（包含四维评分、亮点与面试关注点）', () => {
    const candidate = {
      name: '张三',
      applicationId: 888888,
      jobTitle: '海外增长经理'
    };
    const scoreResult = {
      finalScore: 85,
      decisionTag: '优先推进',
      scoreBreakdown: {
        coreDuty: { score: 90, reason: '有 3 年大盘出海投放操盘经验' },
        business: { score: 85, reason: '业务高度重合' },
        skill: { score: 80, reason: '精通 Adjust 和 SQL' },
        scope: { score: 80, reason: '独立负责国家站' }
      },
      experienceEvidence: '操盘海外 TikTok 预算过千万\n从零搭建投放增长模型',
      concerns: ['近一段任职仅 7 个月，需了解跳槽原因']
    };
    const card = Feishu.buildCandidateCard(candidate, scoreResult, { jobTitle: '海外增长经理' });
    assert.equal(card.msg_type, 'interactive');
    assert.equal(card.card.header.template, 'green');
    assert.match(card.card.header.title.content, /张三/);
    assert.match(card.card.header.title.content, /海外增长经理/);

    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /85/);
    assert.match(jsonStr, /优先推进/);
    assert.match(jsonStr, /大盘出海投放操盘经验/);
    assert.match(jsonStr, /操盘海外 TikTok 预算过千万/);
    assert.match(jsonStr, /近一段任职仅 7 个月/);
    assert.match(jsonStr, /app\.mokahr\.com/);
  });

  it('正确构造筛选汇总卡片', () => {
    const summaryData = {
      jobTitle: '商业化广告产品经理',
      total: 120,
      prioritized: 8,
      recommended: 15,
      durationText: '2 分 45 秒',
      topCandidates: [
        {
          name: '李四',
          score: 92,
          tag: '优先推进',
          profile: '硕士 · 985计算机 · 5年经验 · 高级产品专家',
          highlight: '主导千万级海外广告投放召回系统重构'
        },
        {
          name: '王五',
          score: 88,
          tag: '优先推进',
          profile: '本科 · 211软件 · 4年经验',
          highlight: '具备商业化商业链路搭建实战经验'
        }
      ]
    };
    const card = Feishu.buildScreeningSummaryCard(summaryData);
    assert.equal(card.msg_type, 'interactive');
    assert.match(card.card.header.title.content, /商业化广告产品经理/);
    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /120/);
    assert.match(jsonStr, /优先推进 8 人/);
    assert.match(jsonStr, /建议推进 15 人/);
    assert.match(jsonStr, /建议淘汰 97 人/);
    assert.match(jsonStr, /李四/);
    assert.match(jsonStr, /主导千万级海外广告投放召回系统重构/);
    assert.match(jsonStr, /2 分 45 秒/);

    // 结构对齐校验：候选人各自独立 div，不粘连成单一大段
    const candidateDivs = card.card.elements.filter((el) => el.tag === 'div' && el.text && el.text.content && el.text.content.includes('分**【'));
    assert.equal(candidateDivs.length, 2, '每个候选人应有独立的 div');
    assert.match(candidateDivs[0].text.content, /^\*\*1\. 李四\*\* · \*\*92 分\*\*【🟢 \*\*优先推进\*\*】/);
    assert.match(candidateDivs[1].text.content, /^\*\*2\. 王五\*\* · \*\*88 分\*\*【🟢 \*\*优先推进\*\*】/);
  });

  it('支持超过 5 位的全量 50 分以上候选人推送，每人间距清晰', () => {
    const top8 = Array.from({ length: 8 }, (_, i) => ({
      name: `候选人${i + 1}`,
      score: 80 - i * 3,
      tag: i < 2 ? '优先推进' : '建议推进',
      profile: `本科 · 候选人${i + 1}画像`,
      highlight: `亮点${i + 1}`
    }));
    const card = Feishu.buildScreeningSummaryCard({
      jobTitle: '全球化增长运营',
      total: 10,
      prioritized: 2,
      recommended: 6,
      topCandidates: top8
    });
    const candidateDivs = card.card.elements.filter((el) => el.tag === 'div' && el.text && el.text.content && el.text.content.includes('分**【'));
    assert.equal(candidateDivs.length, 8, '8位达标候选人应全量渲染');
    assert.match(candidateDivs[7].text.content, /^\*\*8\. 候选人8\*\* · \*\*59 分\*\*【🟡 \*\*建议推进\*\*】/);
  });

  it('无 50 分以上合格人选时展示友好兜底提示', () => {
    const card = Feishu.buildScreeningSummaryCard({
      jobTitle: '全球化增长运营',
      total: 10,
      prioritized: 0,
      recommended: 0,
      topCandidates: []
    });
    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /暂无 50 分以上推荐人选/);
  });

  it('正确构造批量推进结果卡片', () => {
    const resultData = {
      jobTitle: '商业化广告产品经理',
      successCount: 5,
      failCount: 0,
      minScore: 60,
      names: ['张三', '李四', '王五', '赵六', '孙七']
    };
    const card = Feishu.buildRecommendationResultCard(resultData);
    assert.equal(card.msg_type, 'interactive');
    assert.equal(card.card.header.template, 'green');
    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /成功推荐：\*\*5\*\* 位/);
    assert.match(jsonStr, /60 分以上/);
    assert.match(jsonStr, /张三、李四/);
  });

  it('兼容 content.js 实际返回口径 { count, names }（v2.0.1 回执分数恒为 0 回归）', () => {
    const card = Feishu.buildRecommendationResultCard({
      ok: true,
      count: 3,
      names: ['张三', '李四', '王五'],
      jobTitle: '海外增长经理'
    });
    assert.equal(card.card.header.template, 'green', '成功推进应显示绿色模板而非红色');
    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /成功推荐：\*\*3\*\* 位/);
    assert.match(jsonStr, /推荐失败：\*\*0\*\* 位/);
    assert.match(jsonStr, /张三、李四、王五/);
  });

  it('ok:true 且无匹配人选时展示说明信息而非伪装失败', () => {
    const card = Feishu.buildRecommendationResultCard({
      ok: true,
      count: 0,
      names: [],
      message: '没有符合条件的候选人',
      jobTitle: '海外增长经理'
    });
    const jsonStr = JSON.stringify(card);
    assert.match(jsonStr, /成功推荐：\*\*0\*\* 位/);
    assert.match(jsonStr, /没有符合条件的候选人/);
  });

  it('失败回执保持红色模板并带失败提示', () => {
    const card = Feishu.buildRecommendationResultCard({
      ok: false,
      error: '未找到打开的 Moka 标签页',
      jobTitle: '海外增长经理'
    });
    assert.equal(card.card.header.template, 'red');
    assert.match(JSON.stringify(card), /未找到打开的 Moka 标签页/);
  });

  it('达标人数超过 20 时统计用全量口径并注明截断（v2.0.1 回归）', () => {
    const top25 = Array.from({ length: 25 }, (_, i) => ({
      name: `候选人${i + 1}`,
      score: 90 - i,
      tag: i < 5 ? '优先推进' : '建议推进',
      profile: `画像${i + 1}`,
      highlight: `亮点${i + 1}`
    }));
    const card = Feishu.buildScreeningSummaryCard({
      jobTitle: '商业化广告产品经理',
      total: 100,
      prioritized: 5,
      recommended: 20,
      topCandidates: top25
    });
    const nameHeader = card.card.elements.find(
      (el) => el.tag === 'div' && el.text && /推荐候选人名单/.test(el.text.content || '')
    );
    assert.match(nameHeader.text.content, /共 25 位/, '名单标题应显示全量达标人数');
    assert.match(nameHeader.text.content, /仅展示前 20/, '截断时必须注明仅展示前 20');
    const candidateDivs = card.card.elements.filter(
      (el) => el.tag === 'div' && el.text && el.text.content && el.text.content.includes('分**【')
    );
    assert.equal(candidateDivs.length, 20, '实际渲染仍截断为 20 人');
  });
});

describe('Feishu 自然语言命令解析器', () => {
  it('正确提取各种形式的推荐分数线', () => {
    const c1 = Feishu.parseFeishuCommand('批量推荐 50 分以上的候选人');
    assert.equal(c1.type, 'recommend_by_score');
    assert.equal(c1.minScore, 50);

    const c2 = Feishu.parseFeishuCommand('@Moka助手 推进60分以上的人');
    assert.equal(c2.type, 'recommend_by_score');
    assert.equal(c2.minScore, 60);

    const c3 = Feishu.parseFeishuCommand('大于70分的推荐一下');
    assert.equal(c3.type, 'recommend_by_score');
    assert.equal(c3.minScore, 70);

    const c4 = Feishu.parseFeishuCommand('50分起推进');
    assert.equal(c4.type, 'recommend_by_score');
    assert.equal(c4.minScore, 50);
  });

  it('正确提取人名推荐指令', () => {
    const c = Feishu.parseFeishuCommand('推荐张三');
    assert.equal(c.type, 'recommend_by_name');
    assert.equal(c.name, '张三');

    const c2 = Feishu.parseFeishuCommand('推进 欧阳六六');
    assert.equal(c2.type, 'recommend_by_name');
    assert.equal(c2.name, '欧阳六六');
  });

  it('正确识别状态查询指令', () => {
    const c = Feishu.parseFeishuCommand('当前进度怎么样了？');
    assert.equal(c.type, 'query_status');

    const c2 = Feishu.parseFeishuCommand('查看筛选状态');
    assert.equal(c2.type, 'query_status');
  });

  it('未能匹配的返回 unknown', () => {
    const c = Feishu.parseFeishuCommand('你好呀');
    assert.equal(c.type, 'unknown');
  });
});

describe('Feishu 推送目标解析器 (resolveFeishuTarget)', () => {
  const sampleTargets = [
    { id: 'target_growth', name: '📱 商业化广告业务群', webhook: 'https://open.feishu.cn/hook/growth' },
    { id: 'target_oversea', name: '🌍 海外增长业务群', webhook: 'https://open.feishu.cn/hook/oversea' },
    { id: 'target_me', name: '👤 泽民个人专属（单人群）', webhook: 'https://open.feishu.cn/hook/me' }
  ];
  const defaultHook = 'https://open.feishu.cn/hook/default';

  it('能准确定位指定目标并返回有效 Webhook', () => {
    const res = Feishu.resolveFeishuTarget('target_growth', sampleTargets, defaultHook);
    assert.equal(res.enabled, true);
    assert.equal(res.webhook, 'https://open.feishu.cn/hook/growth');
    assert.equal(res.name, '📱 商业化广告业务群');
  });

  it('选「不推送飞书」(__none__) 时正确禁用推送', () => {
    const res = Feishu.resolveFeishuTarget('__none__', sampleTargets, defaultHook);
    assert.equal(res.enabled, false);
    assert.equal(res.webhook, null);
  });

  it('指定目标未找到时，优雅回退到默认 Webhook', () => {
    const res = Feishu.resolveFeishuTarget('target_unknown', sampleTargets, defaultHook);
    assert.equal(res.enabled, true);
    assert.equal(res.webhook, defaultHook);
  });

  it('没有任何目标与默认 Webhook 时，安全禁用', () => {
    const res = Feishu.resolveFeishuTarget(null, [], '');
    assert.equal(res.enabled, false);
  });

  it('汇总卡片包含目标名称展示，方便接收者确认归属群', () => {
    const cardWithTarget = Feishu.buildScreeningSummaryCard({
      jobTitle: '商业化广告产品经理',
      targetName: '📱 商业化广告业务群',
      total: 50,
      prioritized: 5,
      recommended: 10
    });
    const jsonStr = JSON.stringify(cardWithTarget);
    assert.match(jsonStr, /推送目标/);
    assert.match(jsonStr, /商业化广告业务群/);

    const cardWithoutTarget = Feishu.buildScreeningSummaryCard({
      jobTitle: '商业化广告产品经理',
      total: 50
    });
    const jsonStr2 = JSON.stringify(cardWithoutTarget);
    assert.doesNotMatch(jsonStr2, /推送目标/);
  });

  it('Bridge 服务器脚本包含 updateFeishuAppCredentials 凭据热保存与热重连能力', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../feishu-bridge/server.js'), 'utf8');
    assert.match(serverCode, /action === 'updateFeishuAppCredentials'/);
    assert.match(serverCode, /handleUpdateCredentials/);
    assert.match(serverCode, /fs\.writeFileSync\(configPath/);
  });

  it('Bridge 服务器脚本支持 sendFeishuCardViaBridge 原生单聊推卡与接收账号自适应', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../feishu-bridge/server.js'), 'utf8');
    assert.match(serverCode, /action === 'sendFeishuCardViaBridge'/);
    assert.match(serverCode, /handleSendCardViaBridge/);
    assert.match(serverCode, /receive_id_type/);
    assert.match(serverCode, /larkClient\.im\.message\.create/);
    assert.match(serverCode, /lastP2pSenderOpenId/);
  });

  it('Feishu 库导出原生 sendFeishuAppCard 且对未填接收账号有友好拦截', async () => {
    assert.equal(typeof Feishu.sendFeishuAppCard, 'function');
    const res = await Feishu.sendFeishuAppCard({
      appId: 'cli_test',
      appSecret: 'sec_test',
      receiver: ''
    }, { test: 1 });
    assert.equal(res.ok, false);
    assert.match(res.error, /未配置个人接收账号/);
  });

  it('buildScreeningSummaryCard 在有达标候选人时生成一键批量推荐按钮与操作链接', () => {
    const cardRes = Feishu.buildScreeningSummaryCard({
      jobTitle: '商业化广告产品经理',
      total: 30,
      prioritized: 3,
      recommended: 5,
      mokaUrl: 'https://app.mokahr.com/recruit/candidate-list?pipelineId=1001',
      topCandidates: [
        { name: '张三', score: 90, tag: '优先推进' }
      ]
    });
    const actionBlock = cardRes.card.elements.find((el) => el.tag === 'action');
    assert.ok(actionBlock, '卡片应包含 action 交互区块');
    assert.ok(actionBlock.actions.length >= 2, '有达标人选时至少包含 2 个操作按钮');
    const batchBtn = actionBlock.actions[0];
    assert.match(batchBtn.text.content, /一键批量推进 50分\+/);
    assert.match(batchBtn.url, /[?&]moka_action=batch_recommend&min_score=50/, '动作参数应在 query 段');
    assert.doesNotMatch(batchBtn.url, /#moka_action/, '不得再放 hash（SPA 路由会冲掉，v2.0.2）');
    assert.deepEqual(batchBtn.value, { action: 'feishuRecommendByScore', minScore: 50 });
  });

  it('一键批量推进 URL：原地址带 hash 路由时参数插入 query 段且路由 hash 原样保留', () => {
    const cardRes = Feishu.buildScreeningSummaryCard({
      jobTitle: '海外增长运营',
      total: 10,
      prioritized: 1,
      recommended: 1,
      mokaUrl: 'https://app.mokahr.com/recruit/candidate-list#/position/99/list',
      topCandidates: [{ name: '张三', score: 90, tag: '优先推进' }]
    });
    const batchBtn = cardRes.card.elements.find((el) => el.tag === 'action').actions[0];
    assert.equal(
      batchBtn.url,
      'https://app.mokahr.com/recruit/candidate-list?moka_action=batch_recommend&min_score=50#/position/99/list',
      '参数插在真正 query 段，路由 hash 原样保留，打开页面视图不漂移'
    );
  });

  it('Bridge 服务器脚本注册了 card.action.trigger 卡片交互按钮监听', () => {
    const serverCode = fs.readFileSync(path.join(__dirname, '../feishu-bridge/server.js'), 'utf8');
    assert.match(serverCode, /'card\.action\.trigger'/);
    assert.match(serverCode, /feishuRecommendByScore/);
  });
});

