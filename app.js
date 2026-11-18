(function () {
  'use strict';
  const M = window.QuoteTracker;
  const KEY = 'tender-quote-checklist-v2';
  const LEGACY_KEY = 'tender-quote-checklist-v1';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let workspace = M.emptyWorkspace();
  let state = M.currentProject(workspace), migrateOnLoad = false, editingProjectId = '';
  let filter = 'all', query = '', categoryFilter = null, toastTimer, blockedStorage = false;
  const collapsedGroups = new Set();
  const bulkUndo = new Map();
  function storageWarning(message) {
    $('#storage-warning').textContent = message;
    $('#storage-warning').classList.remove('hidden');
    $('#save-status').textContent = '目前尚未儲存，請下載備份';
    $('#save-dot').style.background = '#f0c37a';
  }
  try {
    const saved = localStorage.getItem(KEY);
    const legacy = saved ? null : localStorage.getItem(LEGACY_KEY);
    let raw;
    if (saved || legacy) { raw = JSON.parse(saved || legacy); workspace = M.validateWorkspace(raw); }
    state = M.currentProject(workspace);
    migrateOnLoad = (!saved && Boolean(legacy)) || (Boolean(saved) && !Array.isArray(raw.vendorBook));
  } catch (error) {
    blockedStorage = true;
    storageWarning('無法讀取此瀏覽器的儲存資料。為保留原有內容，目前不覆寫舊資料；新增或修改後，請先下載完整備份。可匯入有效備份以重新啟用儲存。');
  }
  function save() {
    const cloud = window.CloudSync ? window.CloudSync.schedule() : false;
    return saveLocal() || cloud;
  }
  function saveLocal() {
    if (blockedStorage) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(workspace));
      $('#save-status').textContent = '變更已自動儲存';
      $('#storage-warning').classList.add('hidden');
      $('#save-dot').style.background = '';
      return true;
    } catch (error) {
      storageWarning('此瀏覽器無法儲存資料，變更目前只保留在此頁。請在關閉前，從「匯出與備份」下載完整備份。');
      return false;
    }
  }
  // crypto.randomUUID 只在 HTTPS／localhost 可用；直接開啟檔案或內網 http 時改用備援編號。
  const uid = () => (window.crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  function toast(message, action) {
    const el = $('#toast');
    clearTimeout(toastTimer); el.textContent = message; el.classList.remove('hidden');
    if (action) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'toast-action'; button.textContent = action.label;
      button.addEventListener('click', () => { el.classList.add('hidden'); clearTimeout(toastTimer); action.run(); });
      el.append(button);
    }
    toastTimer = setTimeout(() => el.classList.add('hidden'), action ? 8000 : 2800);
  }
  const BACKUP_KEY = 'tender-quote-checklist-backup';
  function backupMeta() { try { return JSON.parse(localStorage.getItem(BACKUP_KEY)) || {}; } catch (error) { return {}; } }
  function setBackupMeta(patch) { try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ ...backupMeta(), ...patch })); } catch (error) { /* 無法儲存時略過提醒狀態 */ } }
  function renderBackupReminder() {
    const vendors = workspace.projects.reduce((total, project) => total + project.vendors.length, 0);
    const meta = backupMeta(), date = M.today();
    const since = meta.last ? M.daysBetween(meta.last, date) : null;
    const show = !blockedStorage && !(window.CloudSync && window.CloudSync.active) && vendors > 0 && meta.snooze !== date && (since === null || since >= 7);
    $('#backup-reminder').classList.toggle('hidden', !show);
    if (show) $('#backup-reminder-text').textContent = since === null ? `目前有 ${vendors} 間廠商的進度只存在這個瀏覽器，清除瀏覽資料就會遺失，建議下載一份備份。` : `距上次備份已 ${since} 天，建議再下載一份最新備份。`;
  }
  function setFilter(value) { filter = value; collapsedGroups.clear(); if (view !== 'case') return setView('case'); render(); }
  // 兩種畫面：'case' 目前案件的廠商勾選表；'cases' 所有案件進度總覽（網址加 #cases 可直接開啟）
  let view = location.hash === '#cases' ? 'cases' : 'case';
  function setView(next) {
    view = next;
    try { history.replaceState(null, '', next === 'cases' ? '#cases' : location.pathname + location.search); } catch (error) { /* 略過 */ }
    render(); window.scrollTo({ top: 0 });
  }
  const ovDate = date => date ? date.slice(5).replace('-', '/') : '—';
  function renderOverview() {
    const date = M.today();
    const rank = s => s.deadlineInfo ? (s.deadlineInfo.days >= 0 ? s.deadlineInfo.days : 100000 - s.deadlineInfo.days) : 50000;
    const summaries = workspace.projects.map(entry => M.projectSummary(entry, date)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-TW'));
    const active = summaries.filter(s => s.stage.key !== 'done' && !(s.deadlineInfo && s.deadlineInfo.days < 0));
    const soon = summaries.filter(s => s.deadlineInfo && s.deadlineInfo.days >= 0 && s.deadlineInfo.days <= 7).length;
    const overdueVendors = summaries.reduce((t, s) => t + s.overdue, 0);
    const stat = (label, value, note, tone = '') => `<div class="cases-stat ${tone}"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
    $('#cases-stats').innerHTML = stat('全部案件', summaries.length, `進行中 ${active.length} 件`) + stat('7 天內截止', soon, '依投標截止日計算', soon ? 'waiting' : '') + stat('逾期未回覆廠商', overdueVendors, '超過追蹤期限仍未收到報價', overdueVendors ? 'overdue' : '') + stat('詢價完成', summaries.filter(s => s.stage.key === 'done').length, '所有可報價廠商五步驟完成', 'finished');
    const pill = (label, done, total) => `<li class="${total && done === total ? 'done' : ''} ${!total ? 'empty' : ''}"><span>${label}</span><b>${total ? `${done}/${total}` : '—'}</b></li>`;
    $('#cases-list').innerHTML = summaries.map((s, index) => {
      const entry = workspace.projects.find(p => p.id === s.id), label = projectLabel(entry, workspace.projects.indexOf(entry));
      const dot = (on, text, current) => `<span class="mini-step ${on ? 'on' : ''} ${current ? 'current' : ''}"><i aria-hidden="true">${on ? '✓' : ''}</i><em>${text}</em><span class="sr-only">${on ? '已完成' : current ? '進行中' : '未開始'}</span></span>`;
      const inquiryOn = s.stage.key === 'done';
      return `<article class="case-row ${s.id === workspace.activeProjectId ? 'is-current' : ''}" data-open-project="${esc(s.id)}">
        <div class="case-main">
          <div class="case-title"><strong>${esc(label)}</strong>${s.id === workspace.activeProjectId ? '<span class="case-tag">目前案件</span>' : ''}</div>
          <div class="case-meta"><span>領標 ${ovDate(s.stages.collected)}</span><span>截止 ${ovDate(s.deadline)}</span>${s.deadlineInfo ? `<span class="deadline-badge ${s.deadlineInfo.tone}">${s.deadlineInfo.label}</span>` : ''}</div>
          <div class="mini-steps">${dot(s.stages.collected, '領標', s.stage.key === 'collected')}${dot(s.stages.split, '拆標單', s.stage.key === 'split')}${dot(inquiryOn, '詢價', !inquiryOn && s.stage.key === 'inquiry')}</div>
        </div>
        <div class="case-detail">
          <div class="case-status"><span class="badge ${s.stage.tone}">${s.stage.label}</span>${s.overdue ? `<span class="badge overdue">${s.overdue} 間逾期未回覆</span>` : ''}<span class="case-vendors">${s.groups} 個分類 · ${s.vendors} 間廠商</span></div>
          <ul class="case-counts">${pill('拆圖說', s.counts.drawings, s.groups)}${pill('拆規範', s.counts.specs, s.groups)}${pill('寄信', s.counts.sent, s.quoting)}${pill('電話確認', s.counts.called, s.quoting)}${pill('收到報價', s.counts.received, s.quoting)}${pill('回填', s.counts.filled, s.quoting)}</ul>
        </div>
        <div class="case-progress"><div class="case-percent"><strong>${s.percent}</strong>%</div><div class="case-bar" role="progressbar" aria-valuenow="${s.percent}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)} 整體進度"><i style="width:${s.percent}%"></i></div><button type="button" class="btn secondary case-open" data-open-project="${esc(s.id)}">進入案件<svg><use href="#i-arrow"/></svg></button></div>
      </article>`;
    }).join('');
  }
  function resetView() {
    filter = 'all'; query = ''; categoryFilter = null; collapsedGroups.clear(); $('#search').value = '';
  }
  function projectLabel(project, index) { return project.project.name.trim() || `未命名案件 ${index + 1}`; }
  function renderProjectSelector() {
    const select = $('#project-select');
    const next = workspace.projects.map((entry, index) => `<option value="${esc(entry.id)}">${esc(projectLabel(entry, index))}（${entry.vendors.length} 間廠商）</option>`).join('');
    if (select.innerHTML !== next) select.innerHTML = next;
    select.value = workspace.activeProjectId;
    $('#project-count').textContent = `共 ${workspace.projects.length} 個案件`;
    $('#delete-project').disabled = workspace.projects.length <= 1;
  }
  function renderDeadline() {
    const info = M.deadlineInfo(state.project.deadline);
    const badge = $('#deadline-badge');
    badge.classList.toggle('hidden', !info);
    if (info) { badge.textContent = info.label; badge.className = `deadline-badge ${info.tone}`; }
  }
  function matches(v) {
    const match = filter === 'attention' ? M.attention(v, state.project.days) : filter === 'complete' ? M.complete(v) : filter === 'fill' ? M.pendingFill(v) : true;
    return match && (categoryFilter === null || M.categoryKey(v) === categoryFilter) && (!query || [M.categoryName(v), v.name, v.contact, v.phone, v.email, v.note].join(' ').toLowerCase().includes(query));
  }
  const shortDate = date => date ? date.slice(5).replace('-', '/') : '';
  // 分類標題列的「拆圖說」「拆規範」：同分類廠商共用，每個分類勾一次。
  function prepChips(group) {
    const prep = M.categoryPrep(state.project, group.key);
    return `<span class="prep-chips">${M.categorySteps.map(step => {
      const date = prep[step.key];
      return `<button type="button" class="prep-chip ${date ? 'done' : ''}" data-prep="${step.key}" data-prep-category="${esc(group.key)}" aria-pressed="${Boolean(date)}" title="${date ? `${step.label}已於 ${date} 完成，再點一次取消` : `點一下標記「${esc(group.name)}」${step.label}完成`}"><span class="prep-box">${date ? '✓' : ''}</span>${step.label}${date ? `<small>${shortDate(date)}</small>` : ''}</button>`;
    }).join('')}</span>`;
  }
  // 案件流程卡：① 領標 ② 拆標單 ③ 詢價（含各分類拆圖說/拆規範與廠商進度）
  function renderStages() {
    const project = state.project;
    const stages = { collected: '', split: '', ...(project.stages || {}) };
    const groups = M.groupVendors(state.vendors);
    const quoting = state.vendors.filter(v => !v.noQuote);
    const count = fn => quoting.filter(fn).length;
    const prepCount = key => groups.filter(group => M.categoryPrep(project, group.key)[key]).length;
    const inquiryDone = groups.length > 0 && groups.every(group => M.prepDone(project, group.key)) && quoting.length > 0 && quoting.every(v => v.dates.sent && v.dates.called);
    const current = !stages.collected ? 'collected' : !stages.split ? 'split' : 'inquiry';
    const stageCard = (stage, index) => {
      const date = stages[stage.key];
      return `<button type="button" class="stage-card ${date ? 'done' : ''} ${current === stage.key ? 'current' : ''}" data-stage="${stage.key}" aria-pressed="${Boolean(date)}"><span class="stage-no">${date ? '✓' : index + 1}</span><span class="stage-text"><strong>${stage.label}</strong><small>${date ? `${shortDate(date)} 完成` : current === stage.key ? '目前步驟 · 點一下完成' : '尚未完成'}</small></span></button>`;
    };
    const sub = (label, done, total) => `<li class="${total && done === total ? 'done' : ''}"><span>${label}</span><b>${done}/${total}</b></li>`;
    $('#stage-track').innerHTML = M.projectStages.map(stageCard).join('') +
      `<div class="stage-card inquiry ${inquiryDone ? 'done' : ''} ${current === 'inquiry' ? 'current' : ''}"><span class="stage-no">${inquiryDone ? '✓' : 3}</span><span class="stage-text"><strong>詢價</strong><ul class="stage-subs">${sub('拆圖說', prepCount('drawings'), groups.length)}${sub('拆規範', prepCount('specs'), groups.length)}${sub('寄送 Email', count(v => v.dates.sent), quoting.length)}${sub('電話確認', count(v => v.dates.called), quoting.length)}</ul></span></div>`;
  }
  function groupRows(group) {
    const collapsed = collapsedGroups.has(group.key);
    const finished = group.vendors.filter(M.complete).length;
    const pending = group.vendors.filter(v => M.attention(v, state.project.days)).length;
    return `<tr class="group-row category-tone-${group.tone}"><th colspan="8" scope="colgroup"><div class="group-heading"><button type="button" data-group-toggle="${esc(group.key)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展開' : '收合'} ${esc(group.name)}"><span class="group-chevron ${collapsed ? '' : 'expanded'}">›</span><span class="category-dot" aria-hidden="true"></span><span class="group-name">${esc(group.name)}</span><span class="group-vendor-count">${group.vendors.length} 間廠商</span></button><div class="group-summary">${prepChips(group)}${pending ? `<span class="group-pending">${pending} 間待處理</span>` : ''}<span>已完成 ${finished} / ${group.vendors.length}</span><button type="button" class="group-add" data-group-add="${esc(group.name)}" aria-label="在 ${esc(group.name)} 新增廠商"><svg><use href="#i-plus"/></svg>新增廠商</button></div></div></th></tr>${collapsed ? '' : group.vendors.map(row).join('')}`;
  }
  // 電話、Email 直接可點：手機一按就撥號，電腦開啟郵件程式。
  function contactLine(v) {
    const parts = [];
    if (v.contact) parts.push(esc(v.contact));
    const tel = String(v.phone || '').replace(/[^\d+#*,;]/g, '');
    if (v.phone) parts.push(tel ? `<a href="tel:${esc(tel)}" title="撥打 ${esc(v.phone)}">${esc(v.phone)}</a>` : esc(v.phone));
    const contact = parts.length ? `<span class="vendor-contact">${parts.join(' · ')}</span>` : '';
    const mail = v.email ? `<a class="vendor-email" href="mailto:${esc(encodeURI(v.email))}" title="寄信給 ${esc(v.email)}">${esc(v.email)}</a>` : '';
    return contact + mail;
  }
  function row(v) {
    let status = M.progress(v, state.project.days);
    const due = M.due(v, state.project.days);
    if (!v.noQuote && !v.dates.sent && !M.prepDone(state.project, M.categoryKey(v))) status = { label: '待拆圖說／規範', tone: 'neutral' };
    const late = M.overdue(v, state.project.days);
    const cells = M.steps.map(step => {
      const date = v.dates[step.key];
      const disabled = v.noQuote || (step.key === 'filled' && !v.dates.received && !date);
      const afterDue = step.key === 'followed' && date && due && date > due;
      return `<td><label class="step-check"><input type="checkbox" data-id="${esc(v.id)}" data-step="${step.key}" ${date ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="${esc(v.name)}：${step.label}${disabled && step.key === 'filled' && !v.noQuote ? '（請先勾選收到報價）' : ''}"><span class="step-date ${date ? 'done' : ''} ${afterDue ? 'late' : ''}">${date ? esc(date.slice(5).replace('-', '/')) + (afterDue ? '・逾期' : '') : '—'}</span></label></td>`;
    }).join('');
    return `<tr data-vendor="${esc(v.id)}"><td class="vendor-cell"><span class="vendor-name">${esc(v.name)}</span><span class="vendor-category">${esc(M.categoryName(v))}</span>${contactLine(v)}${v.note ? `<span class="vendor-note">${esc(v.note)}</span>` : ''}</td>${cells}<td><span class="badge ${status.tone}">${status.label}</span>${due && !v.noQuote && !M.complete(v) ? `<span class="due ${late ? 'overdue' : ''}">追蹤期限 ${esc(due.slice(5).replace('-', '/'))}${late ? '・逾期' : ''}</span>` : ''}</td><td><button class="row-edit" data-edit="${esc(v.id)}" aria-label="編輯 ${esc(v.name)}"><svg><use href="#i-edit"/></svg></button></td></tr>`;
  }
  function render() {
    document.body.classList.toggle('view-cases', view === 'cases');
    $('#breadcrumb-current').textContent = view === 'cases' ? '所有案件進度' : '詢價總覽';
    $$('[data-view="cases"]').forEach(button => { button.classList.toggle('active', view === 'cases'); button.setAttribute('aria-pressed', String(view === 'cases')); });
    $('#nav-cases').textContent = workspace.projects.length;
    if (view === 'cases') renderOverview();
    renderProjectSelector();
    const vs = state.vendors;
    const pending = vs.filter(vendor => !vendor.noQuote && !M.complete(vendor)).length;
    $('#complete-all').disabled = pending === 0;
    $('#bulk-count').textContent = pending ? `${pending} 間廠商尚未全部完成` : vs.some(vendor => !vendor.noQuote) ? '所有可報價廠商的步驟皆已完成' : '尚無可勾選的廠商';
    $('#undo-complete-all').classList.toggle('hidden', !bulkUndo.has(state.id));
    const allGroups = M.groupVendors(vs);
    if (categoryFilter !== null && !allGroups.some(group => group.key === categoryFilter)) categoryFilter = null;
    $('#category-count').textContent = `${allGroups.length} 類`;
    $('#category-filters').innerHTML = `<button type="button" class="category-chip ${categoryFilter === null ? 'selected' : ''}" data-category-all aria-pressed="${categoryFilter === null}">全部分類 <span>${vs.length}</span></button>` + allGroups.map(group => `<button type="button" class="category-chip category-tone-${group.tone} ${categoryFilter === group.key ? 'selected' : ''}" data-category="${esc(group.key)}" aria-pressed="${categoryFilter === group.key}"><span class="category-dot" aria-hidden="true"></span><span class="category-label">${esc(group.name)}</span><span class="chip-count">${group.vendors.length}</span></button>`).join('');
    const suggestions = [...new Set([...allGroups.map(group => group.name).filter(name => name !== '未分類'), '水電工程', '泥作工程', '金屬工程', '門窗工程', '裝修工程', '設備採購'])];
    $('#category-options').innerHTML = suggestions.map(name => `<option value="${esc(name)}"></option>`).join('');
    const counts = { total: vs.length, attention: vs.filter(v => M.attention(v, state.project.days)).length, fill: vs.filter(M.pendingFill).length, complete: vs.filter(M.complete).length };
    Object.entries(counts).forEach(([key, value]) => { const e = $('#count-' + key); if (e) e.textContent = value; });
    $('#nav-total').textContent = counts.total; $('#nav-attention').textContent = counts.attention; $('#nav-complete').textContent = counts.complete; $('#tab-total').textContent = counts.total;
    const overdue = vs.filter(v => M.overdue(v, state.project.days)).length;
    $('#attention-caption').textContent = overdue ? `其中 ${overdue} 間逾期尚未回覆` : '確認收信與追蹤進度';
    $$('[data-filter]').forEach(button => { const active = view === 'case' && button.dataset.filter === filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    const visible = vs.filter(matches);
    const visibleGroups = M.groupVendors(visible);
    $('#vendor-rows').innerHTML = visibleGroups.map(groupRows).join('');
    $('#expand-groups').disabled = visible.length === 0;
    $('#collapse-groups').disabled = visible.length === 0;
    $('#empty-state').classList.toggle('hidden', vs.length > 0);
    $('#no-results').classList.toggle('hidden', vs.length === 0 || visible.length > 0);
    $('#results-count').textContent = (visible.length === vs.length ? `共 ${vs.length} 間廠商` : `顯示 ${visible.length} / ${vs.length} 間廠商`) + ` · ${visibleGroups.length} 個分類`;
    $('#flow-days').textContent = state.project.days;
    renderDeadline(); renderBackupReminder(); renderStages();
  }
  function syncProjectInputs() {
    // 正在輸入的欄位不覆寫（例如同事那邊的更新剛好進來）
    const set = (selector, value) => { const el = $(selector); if (document.activeElement !== el) el.value = value; };
    set('#project-name', state.project.name); set('#project-deadline', state.project.deadline); set('#follow-days', state.project.days);
    set('#page-title', M.projectTitle(state.project));
    updateDocumentTitle();
  }
  function updateDocumentTitle() {
    const title = M.projectTitle(state.project);
    $('#page-title').title = title;
    document.title = title + (state.project.name.trim() ? `｜${state.project.name.trim()}` : '');
  }
  syncProjectInputs();
  $('#page-title').addEventListener('input', event => {
    state.project.title = event.target.value.slice(0, 100); updateDocumentTitle(); save();
  });
  $('#page-title').addEventListener('blur', () => {
    state.project.title = M.projectTitle(state.project); $('#page-title').value = state.project.title; updateDocumentTitle(); save();
  });
  $('#page-title').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.target.blur(); } });
  const updateToday = () => { $('#today').textContent = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(new Date()); };
  updateToday();
  $('#project-name').addEventListener('input', event => { state.project.name = event.target.value; updateDocumentTitle(); renderProjectSelector(); save(); });
  $('#project-deadline').addEventListener('change', event => { state.project.deadline = M.validDate(event.target.value) ? event.target.value : ''; save(); renderDeadline(); });
  $('#follow-days').addEventListener('change', event => {
    const days = Number(event.target.value);
    if (!Number.isInteger(days) || days < 1 || days > 30) { event.target.value = state.project.days; toast('追蹤天數請填 1 至 30 的整數'); return; }
    state.project.days = days; save(); render(); toast(`追蹤期限已改為寄信後 ${days} 個日曆天`);
  });
  $('#project-select').addEventListener('change', event => {
    state = M.selectProject(workspace, event.target.value);
    resetView(); syncProjectInputs(); save(); render();
    toast(`已切換至「${state.project.name || '未命名案件'}」`);
  });
  $('#complete-all').addEventListener('click', () => {
    const operation = M.completeProject(state);
    if (!operation.changes.length) return;
    bulkUndo.set(state.id, operation);
    const vendors = new Set(operation.changes.map(change => change.vendorId)).size;
    resetView(); const stored = save(); render();
    $('#undo-complete-all').focus({ preventScroll: true });
    toast(stored ? `已完成 ${vendors} 間廠商、${operation.changes.length} 個步驟，可按「復原本次勾選」取消` : '已勾選完成，請下載完整備份以保留變更');
  });
  $('#undo-complete-all').addEventListener('click', () => {
    const restored = M.undoProjectCompletion(state, bulkUndo.get(state.id));
    bulkUndo.delete(state.id); resetView(); const stored = save(); render();
    if (!$('#complete-all').disabled) $('#complete-all').focus({ preventScroll: true });
    toast(stored ? `已復原本次勾選的 ${restored} 個步驟` : '已復原，請下載完整備份以保留變更');
  });
  const projectDialog = $('#project-dialog'), projectForm = $('#project-form');
  $('#add-project').addEventListener('click', () => {
    projectForm.reset(); projectForm.elements.namedItem('name').setCustomValidity('');
    projectForm.elements.namedItem('days').value = state.project.days;
    $('#copy-vendors-option').classList.toggle('hidden', state.vendors.length === 0);
    $('#copy-vendors-count').textContent = `（${state.vendors.length} 間）`;
    projectDialog.showModal();
  });
  $('#delete-project').addEventListener('click', () => {
    if (workspace.projects.length <= 1) return;
    const name = state.project.name.trim() || '未命名案件';
    if (!confirm(`確定要刪除案件「${name}」？\n其中 ${state.vendors.length} 間廠商與所有勾選記錄會一併刪除。\n（刪除後可在提示中按「復原」，重新整理頁面後就無法復原）`)) return;
    try {
      const removed = M.removeProject(workspace, state.id);
      bulkUndo.delete(removed.project.id);
      state = M.currentProject(workspace); resetView(); syncProjectInputs(); save(); render();
      toast(`已刪除案件「${name}」`, { label: '復原', run: () => {
        try {
          const restored = M.restoreProject(workspace, removed);
          if (!restored) return;
          state = restored; resetView(); syncProjectInputs(); save(); render(); toast(`已復原案件「${name}」`);
        } catch (error) { toast(error.message); }
      } });
    } catch (error) { toast(error.message); }
  });
  $$('.close-project-dialog').forEach(button => button.addEventListener('click', () => projectDialog.close()));
  projectForm.elements.namedItem('name').addEventListener('input', event => event.target.setCustomValidity(''));
  projectForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(projectForm), name = String(data.get('name') || '').trim();
    if (!name) { projectForm.elements.namedItem('name').setCustomValidity('請輸入案件名稱'); projectForm.reportValidity(); return; }
    try {
      const source = state;
      state = M.addProject(workspace, { name, collected: String(data.get('collected') || ''), deadline: String(data.get('deadline') || ''), days: Number(data.get('days')) }, uid());
      const copied = data.get('copyVendors') === 'on' ? M.copyVendorList(source, uid) : [];
      state.vendors = copied;
      resetView(); syncProjectInputs(); const stored = save(); projectDialog.close();
      if (view === 'cases') setView('case'); else render();
      toast(stored ? (copied.length ? `已新增「${state.project.name}」並帶入 ${copied.length} 間廠商` : `已新增「${state.project.name}」，可開始加入廠商`) : '案件已新增，請下載完整備份以保留');
    } catch (error) { toast(error.message); }
  });
  $$('[data-filter]').forEach(button => button.addEventListener('click', () => setFilter(button.dataset.filter)));
  $('#search').addEventListener('input', event => { query = event.target.value.trim().toLowerCase(); collapsedGroups.clear(); render(); });
  $('#reset-filter').addEventListener('click', () => { query = ''; categoryFilter = null; $('#search').value = ''; setFilter('all'); });
  $('#category-filters').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    categoryFilter = button.hasAttribute('data-category-all') ? null : button.dataset.category;
    collapsedGroups.clear(); render();
    const target = $$('#category-filters button').find(b => categoryFilter === null ? b.hasAttribute('data-category-all') : b.dataset.category === categoryFilter);
    if (target) target.focus({ preventScroll: true });
  });
  $('#expand-groups').addEventListener('click', () => { collapsedGroups.clear(); render(); });
  $('#collapse-groups').addEventListener('click', () => {
    M.groupVendors(state.vendors.filter(matches)).forEach(group => collapsedGroups.add(group.key)); render();
  });
  $('#vendor-rows').addEventListener('change', event => {
    const input = event.target;
    if (!input.matches('input[data-step]')) return;
    const vendor = state.vendors.find(v => v.id === input.dataset.id);
    if (!vendor || vendor.noQuote) return;
    if (input.dataset.step === 'filled' && input.checked && !vendor.dates.received) { render(); toast('請先確認已收到報價單'); return; }
    bulkUndo.delete(state.id);
    vendor.dates[input.dataset.step] = input.checked ? M.today() : '';
    const focusId = vendor.id, focusStep = input.dataset.step;
    const stored = save(); render();
    const target = $$('input[data-step]').find(e => e.dataset.id === focusId && e.dataset.step === focusStep);
    if (target) target.focus({ preventScroll: true });
    if (!stored) toast('已更新，請下載備份以保留變更');
  });
  $$('[data-view="cases"]').forEach(button => button.addEventListener('click', () => setView('cases')));
  $('#show-cases').addEventListener('click', () => setView('cases'));
  $('#cases-back').addEventListener('click', () => setView('case'));
  $('#cases-add-project').addEventListener('click', () => $('#add-project').click());
  $('#cases-list').addEventListener('click', event => {
    const target = event.target.closest('[data-open-project]');
    if (!target || event.target.closest('a')) return;
    const id = target.dataset.openProject;
    if (id !== workspace.activeProjectId) { state = M.selectProject(workspace, id); resetView(); syncProjectInputs(); save(); }
    setView('case');
    toast(`已開啟「${state.project.name || '未命名案件'}」`);
  });
  window.addEventListener('hashchange', () => { const next = location.hash === '#cases' ? 'cases' : 'case'; if (next !== view) { view = next; render(); } });
  $('#stage-track').addEventListener('click', event => {
    const card = event.target.closest('[data-stage]');
    if (!card) return;
    const stage = card.dataset.stage, label = M.projectStages.find(s => s.key === stage).label;
    const date = M.toggleStage(state.project, stage);
    const stored = save(); render();
    $$('[data-stage]').find(b => b.dataset.stage === stage)?.focus({ preventScroll: true });
    toast(stored ? (date ? `「${label}」已完成（${date}）` : `已取消「${label}」`) : '已更新，請下載備份以保留變更');
  });
  $('#vendor-rows').addEventListener('click', event => {
    const toggle = event.target.closest('[data-group-toggle]');
    if (toggle) {
      const key = toggle.dataset.groupToggle;
      if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
      render();
      const target = $$('[data-group-toggle]').find(b => b.dataset.groupToggle === key);
      if (target) target.focus({ preventScroll: true });
      return;
    }
    const prep = event.target.closest('[data-prep]');
    if (prep) {
      const key = prep.dataset.prepCategory, step = prep.dataset.prep;
      M.toggleCategoryStep(state.project, key, step);
      const stored = save(); render();
      const target = $$('[data-prep]').find(b => b.dataset.prepCategory === key && b.dataset.prep === step);
      if (target) target.focus({ preventScroll: true });
      if (!stored) toast('已更新，請下載備份以保留變更');
      return;
    }
    const add = event.target.closest('[data-group-add]');
    if (add) { openDialog(undefined, add.dataset.groupAdd); return; }
    const edit = event.target.closest('[data-edit]'); if (edit) openDialog(edit.dataset.edit);
  });
  const dialog = $('#vendor-dialog'), form = $('#vendor-form');
  let autoFilledName = '', autoFilledValues = {};
  const editedProfileFields = new Set();
  const reusableFields = { category: '分類', contact: '聯絡人', phone: '電話', email: '電子郵件' };
  function updateVendorSuggestions() {
    const name = form.elements.namedItem('name').value;
    $('#vendor-name-options').innerHTML = M.searchVendorBook(workspace, name).map(profile => `<option value="${esc(profile.name)}" label="${esc([profile.contact, profile.phone, profile.email].filter(Boolean).join(' · '))}"></option>`).join('');
    $('#vendor-memory-status').textContent = workspace.vendorBook.length ? `已記住 ${workspace.vendorBook.length} 間廠商，輸入名稱或選取建議即可帶入資料。` : '儲存廠商後會記住分類與聯絡資料，下次輸入名稱即可帶入。';
  }
  function fillRememberedVendor() {
    const key = M.vendorNameKey(form.elements.namedItem('name').value);
    if (autoFilledName && autoFilledName !== key) {
      for (const [field, value] of Object.entries(autoFilledValues)) {
        const input = form.elements.namedItem(field);
        if (input.value === value) input.value = '';
      }
      autoFilledValues = {}; autoFilledName = '';
    }
    updateVendorSuggestions();
    const profile = M.findRememberedVendor(workspace, form.elements.namedItem('name').value);
    if (!profile) return;
    const filled = [];
    for (const [field, label] of Object.entries(reusableFields)) {
      const input = form.elements.namedItem(field);
      if (profile[field] && !editedProfileFields.has(field) && (!input.value.trim() || autoFilledValues[field] === input.value)) {
        input.value = profile[field]; autoFilledValues[field] = profile[field]; filled.push(label);
      }
    }
    autoFilledName = key;
    $('#vendor-memory-status').textContent = filled.length ? `已帶入${filled.join('、')}，可修改後再儲存。` : '已找到此廠商的資料，儲存時會記住目前填寫的聯絡資訊。';
  }
  for (const field of Object.keys(reusableFields)) form.elements.namedItem(field).addEventListener('input', () => { editedProfileFields.add(field); delete autoFilledValues[field]; });
  $('#date-fields').innerHTML = M.steps.map(step => `<label>${step.label}<input type="date" name="date-${step.key}" aria-label="${step.label}完成日期"></label>`).join('');
  function openDialog(id, category = '') {
    editingProjectId = workspace.activeProjectId;
    autoFilledName = ''; autoFilledValues = {}; editedProfileFields.clear();
    form.reset(); $('#date-details').open = false;
    const vendor = state.vendors.find(v => v.id === id);
    for (const key of ['id', 'name', 'category', 'contact', 'phone', 'email', 'note']) form.elements.namedItem(key).value = vendor?.[key] || '';
    if (!vendor) {
      const selected = M.groupVendors(state.vendors).find(group => group.key === categoryFilter);
      form.elements.namedItem('category').value = category || selected?.name || '';
    }
    form.elements.namedItem('noQuote').checked = Boolean(vendor?.noQuote);
    for (const step of M.steps) form.elements.namedItem('date-' + step.key).value = vendor?.dates[step.key] || '';
    $('#dialog-title').textContent = vendor ? '編輯詢價廠商' : '新增詢價廠商';
    $('#delete-vendor').classList.toggle('hidden', !vendor);
    updateVendorSuggestions();
    dialog.showModal();
    formSnapshot = formState();
  }
  // 點視窗外或按 Esc 時，若已輸入內容先確認，避免誤觸讓資料消失。
  let formSnapshot = '';
  const formState = () => JSON.stringify([...new FormData(form).entries()]);
  const confirmDiscard = () => formState() === formSnapshot || confirm('剛剛輸入的內容尚未儲存，確定要關閉嗎？');
  $$('.add-vendor').forEach(button => button.addEventListener('click', () => openDialog()));
  $$('.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('cancel', event => { if (!confirmDiscard()) event.preventDefault(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if ((event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) && confirmDiscard()) dialog.close(); } });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (editingProjectId !== workspace.activeProjectId) { dialog.close(); toast('案件已切換，請重新開啟要編輯的廠商'); return; }
    const data = new FormData(form), name = String(data.get('name')).trim();
    if (!name) { form.elements.namedItem('name').setCustomValidity('請輸入廠商名稱'); form.reportValidity(); return; }
    const dates = Object.fromEntries(M.steps.map(step => [step.key, String(data.get('date-' + step.key) || '')]));
    if (dates.filled && !dates.received) { $('#date-details').open = true; toast('已有回填日期，請同時填寫收到報價日期'); form.elements.namedItem('date-received').focus(); return; }
    const existingId = String(data.get('id') || '');
    const twin = M.duplicateVendor(state, name, existingId);
    if (twin && !confirm(`本案件已經有「${twin.name}」（${M.categoryName(twin)}），仍要${existingId ? '儲存' : '再新增一筆'}嗎？`)) { form.elements.namedItem('name').focus(); return; }
    const id = existingId || uid();
    const vendor = { id, name, dates, noQuote: data.get('noQuote') === 'on' };
    for (const key of ['category','contact','phone','email','note']) vendor[key] = String(data.get(key) || '').trim();
    vendor.category = M.normalizeCategory(vendor.category);
    const index = state.vendors.findIndex(v => v.id === id);
    bulkUndo.delete(state.id);
    if (index >= 0) state.vendors[index] = vendor; else state.vendors.push(vendor);
    M.rememberVendor(workspace, vendor);
    categoryFilter = M.categoryKey(vendor); filter = 'all'; query = ''; $('#search').value = ''; collapsedGroups.delete(categoryFilter);
    const stored = save(); render(); dialog.close();
    toast(stored ? (index >= 0 ? '廠商資料已更新' : '廠商已新增，現在可以勾選進度') : '資料已更新，請下載備份以保留');
  });
  form.elements.namedItem('name').addEventListener('input', event => { event.target.setCustomValidity(''); if (!event.isComposing) fillRememberedVendor(); });
  form.elements.namedItem('name').addEventListener('compositionend', fillRememberedVendor);
  form.elements.namedItem('name').addEventListener('change', fillRememberedVendor);
  $('#delete-vendor').addEventListener('click', () => {
    if (editingProjectId !== workspace.activeProjectId) { dialog.close(); toast('案件已切換，請重新選擇廠商'); return; }
    const id = form.elements.namedItem('id').value, vendor = state.vendors.find(v => v.id === id);
    if (!vendor || !confirm(`確定要刪除「${vendor.name}」及其所有確認記錄嗎？`)) return;
    bulkUndo.delete(state.id);
    const project = state, index = project.vendors.indexOf(vendor);
    project.vendors = project.vendors.filter(v => v.id !== id); save(); render(); dialog.close();
    toast(`已刪除「${vendor.name}」`, { label: '復原', run: () => {
      if (!workspace.projects.includes(project) || project.vendors.some(v => v.id === vendor.id)) return;
      project.vendors.splice(Math.min(index, project.vendors.length), 0, vendor);
      save(); render(); toast(`已復原「${vendor.name}」`);
    } });
  });
  function closeExport() { $('#export-menu').classList.add('hidden'); $('#export-toggle').setAttribute('aria-expanded', 'false'); }
  $('#export-toggle').addEventListener('click', () => { const open = $('#export-menu').classList.toggle('hidden'); $('#export-toggle').setAttribute('aria-expanded', String(!open)); });
  document.addEventListener('click', event => { if (!event.target.closest('.export-wrap')) closeExport(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeExport(); });
  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); closeExport();
  }
  function downloadBackup() {
    download(JSON.stringify(workspace, null, 2), `所有案件詢價備份-${M.today()}.json`, 'application/json');
    setBackupMeta({ last: M.today() }); renderBackupReminder();
    toast(`已下載 ${workspace.projects.length} 個案件與 ${workspace.vendorBook.length} 間廠商資料的完整備份`);
  }
  $('#backup').addEventListener('click', downloadBackup);
  $('#backup-now').addEventListener('click', downloadBackup);
  $('#backup-snooze').addEventListener('click', () => { setBackupMeta({ snooze: M.today() }); renderBackupReminder(); });
  $('#print-list').addEventListener('click', () => { closeExport(); resetView(); render(); setTimeout(() => window.print(), 50); });
  $('#export-csv').addEventListener('click', () => {
    const csvCell = value => { let text = String(value ?? ''); if (/^[\t\r\n ]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    const stages = state.project.stages || {};
    const rows = [['標案名稱','投標截止日',...M.projectStages.map(s => s.label + '日期'),'分類',...M.categorySteps.map(s => s.label + '日期'),'廠商名稱','聯絡人','電話','電子郵件',...M.steps.map(s => s.label + '日期'),'追蹤期限','目前進度','備註']];
    for (const group of M.groupVendors(state.vendors)) {
      const prep = M.categoryPrep(state.project, group.key);
      for (const v of group.vendors) rows.push([state.project.name,state.project.deadline,...M.projectStages.map(s => stages[s.key] || ''),M.categoryName(v),...M.categorySteps.map(s => prep[s.key]),v.name,v.contact,v.phone,v.email,...M.steps.map(s => v.dates[s.key]),M.due(v,state.project.days),M.progress(v,state.project.days).label,v.note]);
    }
    download('\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), `廠商詢價追蹤表-${M.today()}.csv`, 'text/csv;charset=utf-8;');
    toast('試算表已匯出，可用 Excel 開啟');
  });
  $('#import').addEventListener('click', () => { closeExport(); $('#import-file').click(); });
  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('備份檔案過大，請使用小於 10 MB 的檔案。');
      const raw = JSON.parse(await file.text()), incoming = M.validateWorkspace(raw);
      if (raw.version === 1) {
        const old = incoming.projects[0];
        state = M.addProject(workspace, { ...old.project, name: old.project.name.trim() || '匯入的案件' }, uid());
        state.vendors = old.vendors;
      } else {
        const vendors = incoming.projects.reduce((total, project) => total + project.vendors.length, 0);
        if (!confirm(`即將匯入 ${incoming.projects.length} 個案件、${vendors} 間廠商。這會取代目前所有案件、廠商資料簿與進度，建議先下載現有完整備份。確定匯入嗎？`)) return;
        workspace = incoming; state = M.currentProject(workspace);
      }
      workspace.vendorBook = M.buildVendorBook(workspace.projects, workspace.vendorBook);
      bulkUndo.clear(); blockedStorage = false; resetView(); syncProjectInputs();
      const stored = save(); render(); toast(stored ? (raw.version === 1 ? '舊版備份已新增為獨立案件，原有案件保留' : '所有案件備份已匯入並儲存') : '備份已匯入，此瀏覽器目前無法儲存');
    } catch (error) { toast(error instanceof SyntaxError ? '檔案不是有效的 JSON 備份' : error.message); }
    finally { event.target.value = ''; }
  });
  window.addEventListener('storage', event => {
    if (event.key === KEY && event.newValue) {
      try {
        const activeId = workspace.activeProjectId;
        workspace = M.validateWorkspace(JSON.parse(event.newValue)); bulkUndo.clear();
        if (workspace.projects.some(project => project.id === activeId)) workspace.activeProjectId = activeId;
        state = M.currentProject(workspace); resetView(); syncProjectInputs(); render(); toast('已更新為另一個分頁儲存的案件資料');
      }
      catch (error) { storageWarning('另一個分頁的資料無法讀取，請先下載目前資料的備份。'); }
    }
  });
  // 逾期判斷只跟「日期」有關：跨日才重繪，避免每分鐘重建表格打斷鍵盤焦點與捲動位置。
  let renderedDay = M.today();
  function refreshIfNewDay() {
    const date = M.today();
    if (date === renderedDay) return;
    renderedDay = date; updateToday(); render();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfNewDay(); });
  setInterval(refreshIfNewDay, 60000);
  render();
  if (migrateOnLoad) save();

  // 提供給雲端同步模組（sync.js）使用
  let remoteRenderTimer = null;
  window.CloudSync?.init({
    M, toast, saveLocal,
    get workspace() { return workspace; },
    replaceWorkspace(next, { remote } = {}) {
      const activeId = workspace.activeProjectId;
      workspace = next;
      if (workspace.projects.some(project => project.id === activeId)) workspace.activeProjectId = activeId;
      const switched = workspace.activeProjectId !== activeId;
      state = M.currentProject(workspace);
      if (switched) { bulkUndo.clear(); resetView(); }
      saveLocal();
      clearTimeout(remoteRenderTimer);
      remoteRenderTimer = setTimeout(() => {
        // 保留正在操作的勾選框焦點
        const focused = document.activeElement?.matches?.('input[data-step]') ? [document.activeElement.dataset.id, document.activeElement.dataset.step] : null;
        syncProjectInputs(); render();
        if (focused) { const target = $$('input[data-step]').find(e => e.dataset.id === focused[0] && e.dataset.step === focused[1]); if (target) target.focus({ preventScroll: true }); }
        if (remote && switched) toast('目前案件已被其他成員刪除，已切換到其他案件');
      }, remote ? 60 : 0);
    }
  });
})();
