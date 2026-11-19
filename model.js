(function (root) {
  'use strict';
  // 廠商詢價：寄出 Email（回覆期限 = 寄出日 + 案件天數）→ 電話提醒（選用）→ 收到報價
  const steps = [
    { key: 'sent', label: '已寄出 Email' },
    { key: 'called', label: '已電話提醒' },
    { key: 'received', label: '已收到報價' }
  ];
  // 案件層級：整個案件各做一次
  const projectStages = [
    { key: 'collected', label: '領標' },
    { key: 'split', label: '拆標單' }
  ];
  // 分類層級：詢價前，每個分類各做一次（同分類廠商共用）
  const categorySteps = [
    { key: 'drawings', label: '拆圖說' },
    { key: 'specs', label: '拆規範' }
  ];
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
  }
  function addDays(value, days) {
    if (!validDate(value)) return '';
    const d = new Date(value + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + Number(days));
    return d.toISOString().slice(0, 10);
  }
  const due = (vendor, days) => addDays(vendor.dates.sent, days);
  // 保固期限：以「年」為單位的整數 0–50；未填為 null
  function cleanWarranty(value) {
    if (value === null || value === undefined || value === '') return null;
    const years = Number(value);
    return Number.isInteger(years) && years >= 0 && years <= 50 ? years : null;
  }
  // 完成 = 已寄出且已收到報價（電話提醒視需要，不是必要步驟）
  const complete = vendor => !vendor.noQuote && Boolean(vendor.dates.sent) && Boolean(vendor.dates.received);
  const overdue = (vendor, days, date = today()) => !vendor.noQuote && !vendor.dates.received && Boolean(due(vendor, days)) && due(vendor, days) < date;
  function progress(vendor, days, date = today()) {
    if (vendor.noQuote) return { label: '結案・不報價', tone: 'neutral' };
    if (vendor.dates.received) return { label: '已收到報價', tone: 'finished' };
    if (!vendor.dates.sent) return { label: '待寄出 Email', tone: 'neutral' };
    if (overdue(vendor, days, date)) return { label: vendor.dates.called ? '逾期・已電話提醒' : '逾期・請電話提醒', tone: 'overdue' };
    return { label: vendor.dates.called ? '已提醒，等待報價' : '等待報價', tone: 'waiting' };
  }
  // 等待報價：已寄出、還沒收到
  const awaitingQuote = vendor => !vendor.noQuote && Boolean(vendor.dates.sent) && !vendor.dates.received;
  const pendingFill = awaitingQuote;
  // 待處理：還沒寄出，或已過回覆期限仍未收到報價
  const attention = (vendor, days, date = today()) => !vendor.noQuote && !vendor.dates.received && (!vendor.dates.sent || overdue(vendor, days, date));
  const blankDates = () => Object.fromEntries(steps.map(step => [step.key, '']));
  const normalizeCategory = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const categoryName = vendor => normalizeCategory(vendor.category) || '未分類';
  const projectTitle = project => typeof project.title === 'string' && project.title.trim() ? project.title.trim().slice(0, 100) : '詢價確認表';
  const categoryKey = vendor => categoryName(vendor).toLocaleLowerCase('zh-TW');
  function categoryTone(key) {
    let hash = 0;
    for (const letter of key) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
    return hash % 6;
  }
  function groupVendors(vendors) {
    const groups = new Map();
    for (const vendor of vendors) {
      const key = categoryKey(vendor);
      if (!groups.has(key)) groups.set(key, { key, name: categoryName(vendor), tone: categoryTone(key), vendors: [] });
      groups.get(key).vendors.push(vendor);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.key === '未分類' && b.key !== '未分類') return 1;
      if (b.key === '未分類' && a.key !== '未分類') return -1;
      return a.name.localeCompare(b.name, 'zh-TW', { numeric: true });
    });
  }
  function validateState(input) {
    if (!input || input.version !== 1 || !input.project || !Array.isArray(input.vendors) || input.vendors.length > 5000) throw new Error('備份格式不正確，請選擇從本頁下載的 JSON 備份。');
    const days = Number(input.project.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('追蹤天數必須介於 1 到 30 天。');
    const str = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
    const ids = new Set();
    const vendors = input.vendors.map(v => {
      if (!v || typeof v.id !== 'string' || !v.id || !/^[\w-]{1,100}$/.test(v.id) || ids.has(v.id) || !v.dates || typeof v.name !== 'string' || !v.name.trim()) throw new Error('備份中的廠商資料不完整或編號重複。');
      ids.add(v.id);
      const dates = blankDates();
      for (const step of steps) {
        const value = v.dates[step.key];
        if (value && !validDate(value)) throw new Error('備份中的完成日期格式不正確。');
        dates[step.key] = value || '';
      }
      return { id: v.id, name: str(v.name, 160).trim(), category: normalizeCategory(str(v.category, 300)) || normalizeCategory(str(v.item, 300)), contact: str(v.contact, 100), phone: str(v.phone, 80), email: str(v.email, 200), note: str(v.note, 2000), noQuote: Boolean(v.noQuote), dates };
    });
    const deadline = input.project.deadline || '';
    if (deadline && !validDate(deadline)) throw new Error('投標截止日期格式不正確。');
    const stages = {};
    for (const stage of projectStages) { const value = input.project.stages?.[stage.key]; stages[stage.key] = validDate(value) ? value : ''; }
    const categoryTasks = {};
    const rawTasks = input.project.categoryTasks;
    if (rawTasks && typeof rawTasks === 'object' && !Array.isArray(rawTasks)) {
      for (const [rawKey, task] of Object.entries(rawTasks).slice(0, 1000)) {
        const key = normalizeCategory(rawKey).toLocaleLowerCase('zh-TW').slice(0, 300);
        if (!key || !task || typeof task !== 'object') continue;
        const entry = {};
        for (const step of categorySteps) entry[step.key] = validDate(task[step.key]) ? task[step.key] : '';
        if (Object.values(entry).some(Boolean)) categoryTasks[key] = entry;
      }
    }
    const project = { name: str(input.project.name, 160), deadline, days, stages, categoryTasks, warrantyYears: cleanWarranty(input.project.warrantyYears) };
    const title = str(input.project.title, 100).trim();
    if (title) project.title = title;
    return { version: 1, project, vendors };
  }
  function workspaceFromLegacy(input) {
    const legacy = validateState(input);
    const projects = [{ id: 'project-default', project: legacy.project, vendors: legacy.vendors }];
    return { version: 2, activeProjectId: 'project-default', projects, vendorBook: buildVendorBook(projects) };
  }
  const emptyWorkspace = () => workspaceFromLegacy({ version: 1, project: { name: '', deadline: '', days: 3 }, vendors: [] });
  function validateWorkspace(input) {
    if (input?.version === 1) return workspaceFromLegacy(input);
    if (!input || input.version !== 2 || !Array.isArray(input.projects) || !input.projects.length || input.projects.length > 200) throw new Error('備份格式不正確，請選擇從本頁下載的案件備份。');
    const ids = new Set();
    const projects = input.projects.map(entry => {
      if (!entry || typeof entry.id !== 'string' || !/^[\w-]{1,100}$/.test(entry.id) || ids.has(entry.id)) throw new Error('案件編號不正確或重複，無法匯入。');
      ids.add(entry.id);
      const clean = validateState({ version: 1, project: entry.project, vendors: entry.vendors });
      return { id: entry.id, project: clean.project, vendors: clean.vendors };
    });
    if (!ids.has(input.activeProjectId)) throw new Error('備份中找不到目前選取的案件。');
    return { version: 2, activeProjectId: input.activeProjectId, projects, vendorBook: buildVendorBook(projects, input.vendorBook) };
  }
  const currentProject = workspace => workspace.projects.find(project => project.id === workspace.activeProjectId);
  function selectProject(workspace, id) {
    const project = workspace.projects.find(entry => entry.id === id);
    if (!project) throw new Error('找不到這個案件，請重新選擇。');
    workspace.activeProjectId = id;
    return project;
  }
  function addProject(workspace, details, id) {
    if (workspace.projects.length >= 200) throw new Error('最多可儲存 200 個案件，請先匯出備份。');
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || workspace.projects.some(project => project.id === id)) throw new Error('案件編號重複，請重試。');
    if (!details || typeof details.name !== 'string' || !details.name.trim()) throw new Error('請輸入案件名稱。');
    const clean = validateState({ version: 1, project: { name: details.name.trim(), deadline: details.deadline || '', days: details.days ?? 3, title: details.title, warrantyYears: details.warrantyYears, stages: details.stages || (details.collected ? { collected: details.collected } : undefined), categoryTasks: details.categoryTasks }, vendors: [] });
    const project = { id, project: clean.project, vendors: clean.vendors };
    workspace.projects.push(project);
    workspace.activeProjectId = id;
    return project;
  }
  function completeProject(project, date = today()) {
    if (!validDate(date)) throw new Error('完成日期格式不正確。');
    const changes = [];
    for (const vendor of project.vendors) {
      if (vendor.noQuote) continue;
      for (const step of steps) {
        if (vendor.dates[step.key]) continue;
        changes.push({ vendorId: vendor.id, step: step.key, previous: vendor.dates[step.key] || '' });
        vendor.dates[step.key] = date;
      }
    }
    return { projectId: project.id, date, changes };
  }
  function undoProjectCompletion(project, operation) {
    if (!operation || operation.projectId !== project.id) return 0;
    const vendors = new Map(project.vendors.map(vendor => [vendor.id, vendor]));
    let restored = 0;
    for (const change of operation.changes) {
      const vendor = vendors.get(change.vendorId);
      if (!vendor || !steps.some(step => step.key === change.step) || vendor.dates[change.step] !== operation.date) continue;
      vendor.dates[change.step] = change.previous;
      restored++;
    }
    return restored;
  }
  const vendorNameKey = name => normalizeCategory(name).toLocaleLowerCase('zh-TW');
  function vendorProfile(vendor) {
    if (!vendor || typeof vendor.name !== 'string' || !vendor.name.trim()) throw new Error('廠商資料簿中的名稱不完整。');
    const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    return { name: clean(vendor.name, 160), category: normalizeCategory(clean(vendor.category, 300)), contact: clean(vendor.contact, 100), phone: clean(vendor.phone, 80), email: clean(vendor.email, 200) };
  }
  function buildVendorBook(projects, saved = []) {
    if (!Array.isArray(saved) || saved.length > 100000) throw new Error('廠商資料簿格式不正確，無法讀取此備份。');
    const book = new Map();
    for (const raw of saved) {
      const profile = vendorProfile(raw), key = vendorNameKey(profile.name);
      if (!book.has(key)) book.set(key, profile);
    }
    const existing = new Set(book.keys());
    for (const project of [...projects].reverse()) {
      for (const vendor of [...project.vendors].reverse()) {
        const profile = vendorProfile(vendor), key = vendorNameKey(profile.name);
        if (existing.has(key)) continue;
        if (!book.has(key)) book.set(key, profile);
        else {
          const known = book.get(key);
          for (const field of ['category', 'contact', 'phone', 'email']) if (!known[field]) known[field] = profile[field];
        }
      }
    }
    return [...book.values()];
  }
  function rememberVendor(workspace, vendor) {
    const profile = vendorProfile(vendor), key = vendorNameKey(profile.name);
    workspace.vendorBook = [profile, ...(workspace.vendorBook || []).filter(entry => vendorNameKey(entry.name) !== key)];
    return profile;
  }
  function searchVendorBook(workspace, name, limit = 20) {
    const query = vendorNameKey(name);
    return (workspace.vendorBook || []).filter(profile => !query || vendorNameKey(profile.name).includes(query)).slice(0, limit);
  }
  const findRememberedVendor = (workspace, name) => (workspace.vendorBook || []).find(profile => vendorNameKey(profile.name) === vendorNameKey(name));
  function removeProject(workspace, id) {
    if (workspace.projects.length <= 1) throw new Error('至少需保留一個案件。');
    const index = workspace.projects.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('找不到這個案件，請重新選擇。');
    const [project] = workspace.projects.splice(index, 1);
    if (workspace.activeProjectId === id) workspace.activeProjectId = workspace.projects[Math.min(index, workspace.projects.length - 1)].id;
    return { project, index };
  }
  function restoreProject(workspace, removed) {
    if (!removed || !removed.project || workspace.projects.some(entry => entry.id === removed.project.id)) return null;
    if (workspace.projects.length >= 200) throw new Error('最多可儲存 200 個案件，無法復原。');
    workspace.projects.splice(Math.min(removed.index, workspace.projects.length), 0, removed.project);
    workspace.activeProjectId = removed.project.id;
    return removed.project;
  }
  // 複製廠商名單到新案件：保留分類與聯絡資料，進度、備註與不報價標記重新開始。
  const copyVendorList = (source, makeId) => source.vendors.map(v => ({ id: makeId(), name: v.name, category: v.category, contact: v.contact, phone: v.phone, email: v.email, note: '', noQuote: false, dates: blankDates() }));
  function daysBetween(from, to) {
    if (!validDate(from) || !validDate(to)) return null;
    return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
  }
  function deadlineInfo(deadline, date = today()) {
    const days = daysBetween(date, deadline);
    if (days === null) return null;
    if (days < 0) return { days, label: `已過投標截止 ${-days} 天`, tone: 'overdue' };
    if (days === 0) return { days, label: '今天投標截止', tone: 'overdue' };
    return { days, label: `距投標截止 ${days} 天`, tone: days <= 3 ? 'waiting' : 'neutral' };
  }
  const categoryPrep = (project, key) => ({ ...Object.fromEntries(categorySteps.map(step => [step.key, ''])), ...(project.categoryTasks?.[key] || {}) });
  const prepDone = (project, key) => categorySteps.every(step => Boolean(categoryPrep(project, key)[step.key]));
  function toggleCategoryStep(project, key, step, date = today()) {
    if (!categorySteps.some(s => s.key === step)) throw new Error('未知的分類步驟。');
    project.categoryTasks = project.categoryTasks || {};
    const entry = categoryPrep(project, key);
    entry[step] = entry[step] ? '' : date;
    if (Object.values(entry).some(Boolean)) project.categoryTasks[key] = entry; else delete project.categoryTasks[key];
    return entry[step];
  }
  function toggleStage(project, stage, date = today()) {
    if (!projectStages.some(s => s.key === stage)) throw new Error('未知的案件步驟。');
    project.stages = { ...Object.fromEntries(projectStages.map(s => [s.key, ''])), ...(project.stages || {}) };
    project.stages[stage] = project.stages[stage] ? '' : date;
    return project.stages[stage];
  }
  // 所有案件進度頁：每個案件的流程階段、各步驟完成數與整體百分比
  function projectSummary(entry, date = today()) {
    const p = entry.project, vendors = entry.vendors, quoting = vendors.filter(v => !v.noQuote);
    const groups = groupVendors(vendors);
    const stages = { ...Object.fromEntries(projectStages.map(s => [s.key, ''])), ...(p.stages || {}) };
    const prepCount = key => groups.filter(g => categoryPrep(p, g.key)[key]).length;
    const stepCount = key => quoting.filter(v => v.dates[key]).length;
    const counts = { drawings: prepCount('drawings'), specs: prepCount('specs') };
    for (const step of steps) counts[step.key] = stepCount(step.key);
    const prepReady = groups.every(g => prepDone(p, g.key));
    const completed = quoting.filter(complete).length;
    // 進度百分比：電話提醒是選用步驟，不列入計算
    const total = projectStages.length + groups.length * categorySteps.length + quoting.length * 2;
    const done = projectStages.filter(s => stages[s.key]).length + counts.drawings + counts.specs + counts.sent + counts.received;
    let stage;
    if (!stages.collected) stage = { key: 'collected', label: '待領標', tone: 'waiting' };
    else if (!stages.split) stage = { key: 'split', label: '待拆標單', tone: 'waiting' };
    else if (!quoting.length) stage = { key: 'inquiry', label: '待新增詢價廠商', tone: 'neutral' };
    else if (completed === quoting.length) stage = { key: 'done', label: '詢價完成', tone: 'finished' };
    else if (!prepReady) stage = { key: 'inquiry', label: '詢價：拆圖說／規範中', tone: 'neutral' };
    else if (counts.sent < quoting.length) stage = { key: 'inquiry', label: '詢價：寄出 Email 中', tone: 'neutral' };
    else stage = { key: 'inquiry', label: '等待廠商報價', tone: 'neutral' };
    return {
      id: entry.id, name: p.name, deadline: p.deadline, deadlineInfo: deadlineInfo(p.deadline, date), stages, stage, warrantyYears: p.warrantyYears ?? null,
      groups: groups.length, vendors: vendors.length, quoting: quoting.length, completed, counts,
      overdue: quoting.filter(v => overdue(v, p.days, date)).length,
      percent: total ? Math.round(done / total * 100) : 0
    };
  }
  const duplicateVendor = (project, name, exceptId = '') => project.vendors.find(v => v.id !== exceptId && vendorNameKey(v.name) === vendorNameKey(name));
  root.QuoteTracker = { steps, today, validDate, addDays, due, complete, overdue, progress, pendingFill, attention, blankDates, normalizeCategory, categoryName, categoryKey, categoryTone, groupVendors, projectTitle, validateState, workspaceFromLegacy, emptyWorkspace, validateWorkspace, currentProject, selectProject, addProject, completeProject, undoProjectCompletion, vendorNameKey, vendorProfile, buildVendorBook, rememberVendor, searchVendorBook, findRememberedVendor, removeProject, restoreProject, copyVendorList, daysBetween, deadlineInfo, duplicateVendor, projectStages, categorySteps, categoryPrep, prepDone, toggleCategoryStep, toggleStage, projectSummary, awaitingQuote, cleanWarranty };
  if (typeof module !== 'undefined') module.exports = root.QuoteTracker;
})(typeof globalThis !== 'undefined' ? globalThis : window);
