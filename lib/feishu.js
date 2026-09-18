/**
 * 飞书协同消息卡片组装与指令解析（background / popup / Node 测试共用）
 */
(function (root) {
  /**
   * 将四维评分与候选人履历组装为飞书互动卡片 (Interactive Card)
   */
  function buildCandidateCard(candidate, scoreResult, jobContext) {
    const cand = candidate || {};
    const res = scoreResult || {};
    const ctx = jobContext || {};
    const name = cand.name || '候选人';
    const jobTitle = ctx.jobTitle || cand.jobTitle || '当前职位';
    const finalScore = res.finalScore != null ? res.finalScore : (res.matchScore || 0);
    const tag = res.decisionTag || (finalScore >= 70 ? '优先推进' : finalScore >= 50 ? '建议推进' : '不建议推进');
    const bd = res.scoreBreakdown || {};

    const headerColor = tag === '优先推进' ? 'green' : (tag === '建议推进' ? 'blue' : 'grey');
    const mokaUrl = cand.detailUrl || (cand.applicationId ? `https://app.mokahr.com/ats-internship/candidate/application/${cand.applicationId}` : '');

    const evidenceList = String(res.experienceEvidence || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    const concernsList = (Array.isArray(res.concerns) ? res.concerns : [])
      .map((s) => String(s).trim())
      .filter((s) => s && s !== '无')
      .slice(0, 3);

    const elements = [
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: { tag: 'lark_md', content: `**🎯 决策建议**\n${tag}` }
          },
          {
            is_short: true,
            text: { tag: 'lark_md', content: `**📊 综合评分**\n**${finalScore}** 分` }
          }
        ]
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**四维能力模型**：\n• **核心职责**：${bd.coreDuty?.score ?? '-'}分（${bd.coreDuty?.reason || '无'}）\n• **业务场景**：${bd.business?.score ?? '-'}分（${bd.business?.reason || '无'}）\n• **核心技能**：${bd.skill?.score ?? '-'}分（${bd.skill?.reason || '无'}）\n• **履历深度**：${bd.scope?.score ?? '-'}分（${bd.scope?.reason || '无'}）`
        }
      }
    ];

    if (evidenceList.length) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**💡 核心亮点**：\n${evidenceList.map((e) => '• ' + e).join('\n')}`
        }
      });
    }

    if (concernsList.length) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**⚠️ 面试探查点**：\n${concernsList.map((c) => '• ' + c).join('\n')}`
        }
      });
    }

    if (mokaUrl) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '在 Moka 查看完整简历' },
            type: 'primary',
            url: mokaUrl
          }
        ]
      });
    }

    return {
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: `【初筛完成】${name} · ${jobTitle}` },
          template: headerColor
        },
        elements
      }
    };
  }

  /**
   * 整批筛选完成汇总卡片
   */
  function buildScreeningSummaryCard(data) {
    const d = data || {};
    const jobTitle = d.jobTitle || '当前职位';
    const total = d.total || 0;
    const prioritized = d.prioritized || 0;
    const recommended = d.recommended || 0;
    const rejected = Math.max(0, total - prioritized - recommended);
    const durationText = d.durationText || '刚刚';
    const mokaUrl = d.mokaUrl || 'https://app.mokahr.com';
    const qualifiedTotal = Array.isArray(d.topCandidates) ? d.topCandidates.length : 0;
    const topCandidates = qualifiedTotal ? d.topCandidates.slice(0, 20) : [];

    const elements = [];

    // 1. 核心看板 (高对比度数据概况盘)
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**📊 筛选漏斗概况**\n• **初筛总数**：共 **${total}** 位候选人（耗时 ${durationText}）\n• **梯队分布**：🟢 **优先推进 ${prioritized} 人** | 🟡 **建议推进 ${recommended} 人** | ⚪ **建议淘汰 ${rejected} 人**`
      }
    });

    elements.push({ tag: 'hr' });

    // 2. 重点推荐候选人 (>=50 分达标人选按分值高低展示，每人独立模块对齐，杜绝粘连)
    if (topCandidates.length > 0) {
      const truncateNote = qualifiedTotal > topCandidates.length ? ` · 仅展示前 ${topCandidates.length}` : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**🔥 推荐候选人名单（共 ${qualifiedTotal} 位 · 50 分以上从高到低${truncateNote}）**`
        }
      });

      topCandidates.forEach((c, idx) => {
        const rank = idx + 1;
        const tag = c.tag || (c.score >= 80 ? '优先推进' : '建议推进');
        const tagIcon = tag === '优先推进' ? '🟢' : '🟡';
        const profile = c.profile ? `\n💼 **背景画像**：${c.profile}` : '';
        const highlight = c.highlight ? `\n💡 **核心亮点**：${c.highlight}` : '';

        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${rank}. ${c.name}** · **${c.score} 分**【${tagIcon} **${tag}**】${profile}${highlight}`
          }
        });

        // 候选人之间添加浅分割线，保持整齐对齐
        if (idx < topCandidates.length - 1) {
          elements.push({ tag: 'hr' });
        }
      });

      elements.push({ tag: 'hr' });
    } else {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `💡 **本轮初筛暂无 50 分以上推荐人选**（共 ${total} 人，已全部归入建议淘汰）`
        }
      });
      elements.push({ tag: 'hr' });
    }

    // 3. 推进处理指引
    const qualifiedCount = prioritized + recommended;
    const guideText = qualifiedCount > 0
      ? `💡 **一键协同**：点下方【🚀 一键批量推进】会在**你已打开的 Moka 页面**直接执行批量推进（不新开网页），完成后自动刷新页面并把「推荐给谁 + 结果」回推到这里\n_需本地 Bridge 运行中并已配置自建应用；若无响应，请在项目文件夹终端执行 bash 安装开机自启.command_`
      : `💡 **初筛完成**：当前岗位暂无 50 分以上候选人，点击下方按钮前往 Moka 查阅全部结果`;

    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: guideText
      }
    });

    // 4. 交互操作按钮
    const actions = [];
    if (qualifiedCount > 0) {
      // 主按钮走卡片交互回调（不带 url 才会触发回调）：由本地 Bridge 直连已打开的
      // Moka 标签页执行，执行完自动刷新页面并回推结果；不再自动新开网页（2.2.0）
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: `🚀 一键批量推进 50分+ (共 ${qualifiedCount} 人)` },
        type: 'primary',
        value: {
          action: 'feishuRecommendByScore',
          minScore: 50,
          mokaUrl: String(mokaUrl || 'https://app.mokahr.com'),
          // v3.5.0：卡片自带职位身份——执行侧先核对页面职位再推进，防多职位标签并存时推错岗
          jobTitle: String(jobTitle || '')
        }
      });

      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '📋 查看候选人列表' },
        type: 'default',
        url: mokaUrl
      });
    } else {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '前往 Moka 查看初筛结果 →' },
        type: 'primary',
        url: mokaUrl
      });
    }

    elements.push({
      tag: 'action',
      actions
    });

    return {
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: `📋 Moka 初筛报告 · ${jobTitle}` },
          template: 'turquoise'
        },
        elements
      }
    };
  }

  /** v3.5.0：推荐对象名单的来源标注（确认章时间 / 未补章提示） */
  function assigneeSourceText(confirmedAt) {
    const ts = Number(confirmedAt) || 0;
    if (!ts) return '（未确认章 · 建议回插件「配置」页点「确认本岗简历推荐对象」补章）';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `（确认于 ${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}）`;
  }

  /**
   * 批量推进/推荐操作结果卡片
   */
  function buildRecommendationResultCard(data) {
    const d = data || {};
    // content.js handleFeishuRecommend 返回 { count, names }，兼容旧 successCount/failCount 口径
    const successCount = d.successCount != null ? d.successCount : (d.count || 0);
    const failCount = d.failCount || 0;
    const minScore = d.minScore;
    const jobTitle = d.jobTitle || '当前岗位';
    const names = Array.isArray(d.names) ? d.names : [];
    const assignees = (Array.isArray(d.assignees) ? d.assignees : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    // v3.5.0：推荐对象标注确认章来源——「确认于 9-18 11:44」= 用户拍板过的名单；
    // 「未确认章」= 旧记录/从未点过确认，提示回插件补章（确认过的名单才会被优先采用）
    const confirmedAt = Number(d.assigneeConfirmedAt) || 0;

    const isSuccess = successCount > 0 && failCount === 0;
    const template = isSuccess ? 'green' : (successCount > 0 ? 'orange' : 'red');

    let desc = '';
    if (minScore != null) {
      desc = `按条件【${minScore} 分以上】执行批量推进：\n`;
    }

    // 推荐对象（用人部门 / 面试官）：让 HR 在群里就能确认「推给了谁」+ 名单是否确认过
    const assigneeText = assignees.length
      ? `\n• **推荐对象**：${assignees.join('、')}${assigneeSourceText(confirmedAt)}`
      : '';

    let namesText = '';
    if (names.length) {
      const shown = names.slice(0, 30);
      const suffix = names.length > shown.length ? ` 等 ${names.length} 位` : '';
      namesText = `\n• **候选人（被推荐人）**：${shown.join('、')}${suffix}`;
    }

    const refreshText = d.refreshed
      ? '\n• **Moka 页面**：已自动刷新，候选人已从「初筛」列表移出'
      : '';

    return {
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: `🤖 飞书指令执行结果 · ${jobTitle}` },
          template
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `${desc}• 成功推荐：**${successCount}** 位\n• 推荐失败：**${failCount}** 位${assigneeText}${namesText}${refreshText}${d.error ? `\n• 失败提示：${d.error}` : (d.message ? `\n• ${d.message}` : '')}`
            }
          }
        ]
      }
    };
  }

  /**
   * 自然语言与指令解析器
   * 支持解析：
   *  - "推荐 50 分以上" / "推进 60分以上的候选人" / "大于50分的推进"
   *  - "推荐 张三" / "推进李四"
   *  - "查看进度" / "当前状态"
   */
  function parseFeishuCommand(text) {
    const raw = String(text || '').trim();
    if (!raw) return { type: 'unknown', raw: '' };

    // 匹配 "推荐/推进/分配 X 分以上" 或 "大于/高于 X 分"
    const scoreMatch = /(?:推荐|推进|分配).*?(\d{1,3})\s*分|(\d{1,3})\s*分.*?(?:以上|起).*?(?:推荐|推进|分配)|(?:大于|高于|超过)\s*(\d{1,3})\s*分.*?(?:推荐|推进)/i.exec(raw);
    if (scoreMatch) {
      const scoreStr = scoreMatch[1] || scoreMatch[2] || scoreMatch[3];
      const minScore = Math.min(100, Math.max(0, parseInt(scoreStr, 10)));
      return {
        type: 'recommend_by_score',
        minScore,
        raw
      };
    }

    // 匹配人名推荐："推荐/推进 张三"
    const nameMatch = /(?:推荐|推进|分配)\s*([^\s\d,，]{2,10})/i.exec(raw);
    if (nameMatch && !/候选人|以上|所有人|全部|高分/.test(nameMatch[1])) {
      return {
        type: 'recommend_by_name',
        name: nameMatch[1].trim(),
        raw
      };
    }

    // 匹配查询状态："状态"、"进度"
    if (/(?:状态|进度|筛选情况|结果)/i.test(raw)) {
      return {
        type: 'query_status',
        raw
      };
    }

    return {
      type: 'unknown',
      raw
    };
  }

  /**
   * 缓存飞书自建应用访问凭据 tenant_access_token
   */
  let cachedTenantToken = { appId: '', token: '', expireAt: 0 };

  async function getTenantAccessToken(appId, appSecret) {
    const cleanAppId = String(appId || '').trim();
    const cleanAppSecret = String(appSecret || '').trim();
    if (!cleanAppId || !cleanAppSecret) {
      throw new Error('未配置飞书自建应用 App ID 与 App Secret');
    }
    const now = Date.now();
    if (cachedTenantToken.appId === cleanAppId && cachedTenantToken.token && cachedTenantToken.expireAt > now + 60000) {
      return cachedTenantToken.token;
    }
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cleanAppId, app_secret: cleanAppSecret })
    });
    if (!resp.ok) {
      throw new Error(`获取飞书凭据 HTTP 异常: ${resp.status}`);
    }
    const data = await resp.json().catch(() => ({}));
    if (data.code !== 0) {
      throw new Error(`飞书凭据校验失败: ${data.msg || `错误码 ${data.code}`}`);
    }
    cachedTenantToken = {
      appId: cleanAppId,
      token: data.tenant_access_token,
      expireAt: now + (data.expire || 7200) * 1000
    };
    return cachedTenantToken.token;
  }

  /**
   * 飞书自建应用原生单聊直发卡片消息（零依赖本地进程）
   */
  async function sendFeishuAppCard({ appId, appSecret, receiver }, cardPayload) {
    const target = String(receiver || '').trim();
    if (!target) {
      return { ok: false, error: '未配置个人接收账号（请在设置中填入企业邮箱 xxx@meitu.com 或 Open ID）' };
    }

    let receive_id_type = 'open_id';
    if (target.includes('@')) {
      receive_id_type = 'email';
    } else if (target.startsWith('oc_')) {
      receive_id_type = 'chat_id';
    } else if (target.startsWith('ou_')) {
      receive_id_type = 'open_id';
    }

    try {
      const token = await getTenantAccessToken(appId, appSecret);
      const rawCard = cardPayload && (cardPayload.card || cardPayload);
      const contentStr = typeof rawCard === 'string' ? rawCard : JSON.stringify(rawCard);

      const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receive_id_type}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          receive_id: target,
          msg_type: 'interactive',
          content: contentStr
        })
      });

      if (!resp.ok) {
        return { ok: false, error: `飞书接口 HTTP ${resp.status}: ${resp.statusText}` };
      }
      const data = await resp.json().catch(() => ({}));
      if (data.code !== 0) {
        return { ok: false, error: `飞书开放平台返回: ${data.msg} (错误码: ${data.code})` };
      }
      return { ok: true, data, via: 'feishu_app_direct' };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  const api = {
    buildCandidateCard,
    buildScreeningSummaryCard,
    buildRecommendationResultCard,
    parseFeishuCommand,
    sendFeishuAppCard
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MokaFeishu = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
