/**
 * 候选人画像、JD 文本与本地硬门槛（content / Node 测试共用）
 */
(function (root) {
  const DEGREE_RANK = { 大专: 1, 专科: 1, 本科: 2, 学士: 2, 硕士: 3, 研究生: 3, 博士: 4 };

  // ---- v3.4.1 输入体量上限（实锤：海外候选人附件简历解析出的长文本整段进提示词，
  // 网关 150s 连续超时 → 该候选人永远评分失败）。上限只拦极端体量，常规简历不受影响；
  // 触发时由 content 侧写运行日志（含原始长度），保证截断可见、可追溯。
  const RESUME_TEXT_MAX_CHARS = 8000;   // 附件解析出的简历原件文本
  const EXPERIENCE_ITEM_MAX_CHARS = 1200; // 单条经历描述
  const EXPERIENCE_ITEMS_MAX = 12;      // 每类经历（工作/实习/项目）条数
  const PROFILE_MAX_CHARS = 20000;      // 画像总长兜底（双保险，正常远低于此）
  const TRUNC_SUFFIX = '…（文本过长，已截断）';

  /** 超长文本按上限截断（保留头部：简历/经历的关键信息都在前面） */
  function clampText(raw, max) {
    const s = String(raw == null ? '' : raw);
    if (!Number.isFinite(max) || max <= 0 || s.length <= max) return { text: s, truncated: false };
    return { text: s.slice(0, max) + TRUNC_SUFFIX, truncated: true };
  }

  const SCHOOL_TAGS = {
    211: ['211'],
    985: ['985'],
    双一流: ['双一流大学', '双一流学科'],
    留学生: ['海外教育背景'],
    QS100: ['QS50', 'QS100'],
    QS500: ['QS50', 'QS100', 'QS200', 'QS300', 'QS500']
  };

  function stripHtml(html) {
    if (!html) return '';
    let t = String(html);
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    t = t
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/gm, '');
    return t.trim();
  }

  function formatExperienceList(arr) {
    if (!Array.isArray(arr) || !arr.length) return '';
    return arr
      .slice(0, EXPERIENCE_ITEMS_MAX)
      .map((e) => {
        if (!e || typeof e !== 'object') return '';
        const org =
          e.company ||
          e.organization ||
          e.orgName ||
          e.employer ||
          e.unit ||
          e.projectName ||
          e.school ||
          e.name ||
          '';
        const title = e.title || e.position || e.role || e.jobTitle || e.projectRole || '';
        const dept = e.department ? '[' + e.department + ']' : '';
        const start = e.startDate || e.startTime || e.start || e.beginDate || e.from || '';
        const end = e.endDate || e.endTime || e.end || e.to || '';
        const period = start || end ? ' (' + start + '~' + end + ')' : '';
        const head = (org + ' ' + title + dept + period).replace(/\s+/g, ' ').trim();
        const desc =
          e.summary ||
          e.content ||
          e.description ||
          e.duty ||
          e.workContent ||
          e.responsibility ||
          e.responsibilities ||
          e.detail ||
          e.desc ||
          e.projectDescription ||
          '';
        const line = desc ? head + ': ' + String(desc).trim() : head;
        return clampText(line.trim(), EXPERIENCE_ITEM_MAX_CHARS).text;
      })
      .filter((s) => s && s !== ':' && s !== '()')
      .join('\n');
  }

  function hasAnyExperience(app) {
    return ['experienceInfo', 'practiceInfo', 'projectInfo'].some(
      (k) => Array.isArray(app && app[k]) && app[k].length
    );
  }

  function formatAgeRangeLabel(min, max) {
    if (min != null && max == null) return min + '+';
    if (min != null && max != null) return min + '-' + max;
    if (min == null && max != null) return '≤' + max;
    return '不限';
  }

  function ageInRange(age, r) {
    if (r.min != null && age < r.min) return false;
    if (r.max != null && age > r.max) return false;
    return true;
  }

  function normalizeAgeRanges(hc) {
    if (!hc) return [];
    if (Array.isArray(hc.ageRanges) && hc.ageRanges.length) {
      return hc.ageRanges
        .filter((r) => r && (r.min != null || r.max != null))
        .map((r) => ({
          min: r.min != null ? Number(r.min) : null,
          max: r.max != null ? Number(r.max) : null,
          label: r.label || formatAgeRangeLabel(r.min, r.max)
        }));
    }
    if (hc.ageMin != null || hc.ageMax != null) {
      return [
        {
          min: hc.ageMin != null ? Number(hc.ageMin) : null,
          max: hc.ageMax != null ? Number(hc.ageMax) : null,
          label: formatAgeRangeLabel(hc.ageMin, hc.ageMax)
        }
      ];
    }
    return [];
  }

  function evaluateHardConditions(app, hc, jobType) {
    const missing = [];
    const unknown = [];
    const a = app || {};
    if (!hc) return { passed: true, missing, unknown };
    if (hc.degree) {
      const need = DEGREE_RANK[hc.degree] || 0;
      const rawHave = String(a.highestDegree || '').trim();
      if (!rawHave) unknown.push('学历需' + hc.degree + '及以上');
      else {
        const have = DEGREE_RANK[rawHave] || 0;
        if (!have || have < need) missing.push('学历需' + hc.degree + '及以上');
      }
    }
    if (Array.isArray(hc.schools) && hc.schools.length) {
      const tags = Array.isArray(a.intelligentTags) ? a.intelligentTags : [];
      const tagNames = new Set(tags.map((t) => t && t.name).filter(Boolean));
      if (!tagNames.size && !String(a.highestDegreeSchool || '').trim()) {
        unknown.push('院校不符（需 ' + hc.schools.join('/') + '）');
      } else {
        const ok = hc.schools.some((s) => (SCHOOL_TAGS[s] || [s]).some((t) => tagNames.has(t)));
        if (!ok) missing.push('院校不符（需 ' + hc.schools.join('/') + '）');
      }
    }
    if (hc.exp) {
      const rawYears = a.experience;
      const hasYears = rawYears !== undefined && rawYears !== null && String(rawYears).trim() !== '';
      if (!hasYears) unknown.push('经验需 ' + (hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'));
      else {
        const years = Number(rawYears);
        if (!Number.isFinite(years)) unknown.push('经验需 ' + (hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'));
        else {
          let ok = true;
          if (hc.exp === 'fresh') ok = years <= 1;
          else if (hc.exp === '1-3') ok = years >= 1 && years < 3;
          else if (hc.exp === '3-5') ok = years >= 3 && years <= 5;
          else if (hc.exp === '5+') ok = years >= 5;
          if (!ok) missing.push('经验需 ' + (hc.exp === 'fresh' ? '在校/应届' : hc.exp + '年'));
        }
      }
    }
    if (hc.gender) {
      const gender = String(a.gender || '').trim();
      if (!gender) unknown.push('性别需' + hc.gender);
      else if (!gender.includes(hc.gender)) missing.push('性别需' + hc.gender);
    }
    if (hc.internship === 'required' && jobType === 'intern') {
      const hasExp = hasAnyExperience(a) || Number(a.experience) > 0;
      if (!hasExp) unknown.push('缺相关实习经验');
    }
    const age = Number(a.age);
    const ranges = normalizeAgeRanges(hc);
    if (ranges.length) {
      if (!Number.isFinite(age) || age <= 0) unknown.push('年龄需 ' + ranges.map((r) => r.label).join('/'));
      else {
        const ok = ranges.some((r) => ageInRange(age, r));
        if (!ok) missing.push('年龄需 ' + ranges.map((r) => r.label).join('/'));
      }
    }
    return { passed: missing.length === 0, missing, unknown };
  }

  function extractMajorsFromText(text) {
    const majors = new Set();
    const STOP = new Set([
      '相关',
      '专业',
      '等',
      '以上',
      '学历',
      '背景',
      '毕业',
      '不限',
      '优先',
      '类',
      '方向',
      '及其',
      '以及',
      '或',
      '和',
      '有'
    ]);
    const REJECT =
      /(学历|本科|硕士|博士|大专|专科|以上|及以|毕业|优先|熟练|精通|熟悉|具备|掌握|能力|经验|工作|要求|负责|岗位|以下|良好|扎实|以及)/;
    const collect = (str) => {
      String(str || '')
        .split(/[、，,/\s]+/)
        .forEach((raw) => {
          const t = raw
            .trim()
            .replace(/(相关|类|方向|专业|优先|背景|毕业|等)+$/, '')
            .trim();
          if (t && t.length >= 2 && t.length <= 8 && !STOP.has(t) && !REJECT.test(t)) majors.add(t);
        });
    };
    let m;
    const colon = /专业[:：]\s*([\u4e00-\u9fa5A-Za-z、，,/\s]{2,40})/g;
    while ((m = colon.exec(text || ''))) collect(m[1]);
    const suffix =
      /([\u4e00-\u9fa5A-Za-z]{2,10}?(?:[、/][\u4e00-\u9fa5A-Za-z]{2,10})*)((?:等)?(?:相关|类)?)专业/g;
    while ((m = suffix.exec(text || ''))) {
      const list = m[1];
      const qual = m[2];
      if (qual || /[、/]/.test(list)) collect(list);
    }
    return [...majors].slice(0, 6);
  }

  function buildCandidateProfile(app) {
    const lines = [];
    const push = (label, value) => {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        lines.push(label + ': ' + String(value).trim());
      }
    };
    push('姓名', app.name);
    push('性别', app.gender);
    push('年龄', app.age);
    push('最高学历', app.highestDegree);
    if (app.highestDegreeSchool || app.highestDegreeSpeciality) {
      push(
        '最高学历院校/专业',
        (app.highestDegreeSchool || '') + ' ' + (app.highestDegreeSpeciality || '')
      );
    }
    if (Array.isArray(app.educationInfo) && app.educationInfo.length) {
      const edu = app.educationInfo
        .map((e) =>
          (
            (e.academicDegree || '') +
            ' ' +
            (e.school || '') +
            ' ' +
            (e.speciality || '') +
            ' (' +
            (e.startDate || '') +
            '~' +
            (e.endDate || '') +
            ')'
          ).trim()
        )
        .join('；');
      push('教育经历', edu);
    }
    const workExp = formatExperienceList(app.experienceInfo);
    const practiceExp = formatExperienceList(app.practiceInfo);
    const projectExp = formatExperienceList(app.projectInfo);
    if (workExp) push('工作经历', '\n' + workExp);
    if (practiceExp) push('实习经历', '\n' + practiceExp);
    if (projectExp) push('项目/校园经历', '\n' + projectExp);
    if (!workExp && !practiceExp && !projectExp && app.experience) {
      push('工作经验(年)', app.experience);
    }
    push('技能', app.skill && app.skill.replace(/\n/g, '，'));
    const awardsText =
      Array.isArray(app.awardInfo) && app.awardInfo.length
        ? app.awardInfo
            .map((a) =>
              (
                (a.name || a.awardName || a.title || '') +
                ' ' +
                (a.date || a.awardDate || '')
              ).trim()
            )
            .filter(Boolean)
            .join('，')
        : app.awards && String(app.awards).replace(/\n/g, '，');
    push('奖项/证书', awardsText);
    push('自我介绍', app.personal);
    if (Array.isArray(app.intelligentTags) && app.intelligentTags.length) {
      push(
        '标签',
        app.intelligentTags
          .map((t) => t.name)
          .filter(Boolean)
          .join('、')
      );
    }
    push('求职类型', app.commitment);
    push('意向城市', app.location);
    if (typeof app.matchingIndex === 'number') {
      push('Moka匹配度', Math.round(app.matchingIndex * 100) + '%');
    }
    if (app.__resumeText && String(app.__resumeText).trim()) {
      // v3.4.1：附件解析文本按上限截断——超长文本会让网关请求超时（150s×2 后落卡失败）
      const resume = clampText(String(app.__resumeText).trim(), RESUME_TEXT_MAX_CHARS);
      push('简历原件（附件解析）', '\n' + resume.text);
    }
    // 双保险：画像总长兜底（正常远低于上限，只有多处同时超长才会命中）
    return clampText(lines.join('\n'), PROFILE_MAX_CHARS).text;
  }

  function buildJobJD(app) {
    const job = (app && app.job) || {};
    const parts = [];
    if (job.title || (app && app.jobTitle)) parts.push('职位: ' + (job.title || app.jobTitle));
    if (job.departmentName) parts.push('部门: ' + job.departmentName);
    const desc = stripHtml(job.description || (app && app.jobDescription) || '');
    if (desc) parts.push('岗位描述与要求:\n' + desc);
    if (job.aiEvalRequirementInfo) parts.push('硬性/加分要求:\n' + job.aiEvalRequirementInfo);
    return parts.join('\n\n');
  }

  const api = {
    RESUME_TEXT_MAX_CHARS,
    PROFILE_MAX_CHARS,
    stripHtml,
    formatExperienceList,
    hasAnyExperience,
    evaluateHardConditions,
    extractMajorsFromText,
    buildCandidateProfile,
    buildJobJD
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MokaCandidateProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
