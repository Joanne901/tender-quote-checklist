// 雲端同步（Supabase）：登入後，案件、廠商與進度存到雲端，團隊成員在任何裝置看到同一份資料。
// 設計：app.js 照舊修改記憶體中的 workspace 並呼叫 save()；這裡比對「上次同步的內容」，只上傳有變動的列。
(function () {
  'use strict';
  const cfg = window.SUPABASE_CONFIG || {};
  const enabled = Boolean(cfg.url && cfg.anonKey && window.supabase && window.supabase.createClient);
  const LOCAL_COPY_KEY = 'tender-quote-checklist-local-before-cloud';
  let app = null, sb = null, session = null, channel = null;
  let mode = enabled ? 'signed-out' : 'off'; // off | signed-out | checking | not-member | synced | syncing | error
  let synced = new Map(); // key -> 上次與雲端一致的 JSON
  let pushTimer = null, pushing = false, pushAgain = false, renderTimer = null, members = [];
  const $ = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 資料列 <-> workspace ----------
  const projectRow = (entry, position) => ({ id: entry.id, position, name: entry.project.name, deadline: entry.project.deadline || '', days: entry.project.days, title: entry.project.title || null, stages: entry.project.stages || {}, category_tasks: entry.project.categoryTasks || {}, warranty_years: entry.project.warrantyYears ?? null });
  const vendorRow = (v, projectId, position) => ({ id: v.id, project_id: projectId, position, name: v.name, category: v.category || '', contact: v.contact || '', phone: v.phone || '', email: v.email || '', note: v.note || '', no_quote: Boolean(v.noQuote), dates: v.dates });
  const bookRow = profile => ({ key: app.M.vendorNameKey(profile.name), profile });
  const keyOf = (table, row) => table + ':' + (table === 'vendor_book' ? row.key : row.id);
  // 資料庫的 jsonb 會重排欄位順序，所以比對前先把每一層的 key 排序。
  const sortDeep = v => Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])])) : v;
  const stable = row => JSON.stringify(sortDeep(row));
  const clean = row => { const out = { ...row }; delete out.updated_at; delete out.updated_by; return out; };

  function currentRows() {
    const rows = new Map();
    app.workspace.projects.forEach((entry, i) => {
      const p = projectRow(entry, i); rows.set(keyOf('projects', p), { table: 'projects', row: p });
      entry.vendors.forEach((v, j) => { const r = vendorRow(v, entry.id, j); rows.set(keyOf('vendors', r), { table: 'vendors', row: r }); });
    });
    for (const profile of app.workspace.vendorBook || []) { const r = bookRow(profile); if (r.key) rows.set(keyOf('vendor_book', r), { table: 'vendor_book', row: r }); }
    return rows;
  }
  function workspaceFromRows(projects, vendors, book, activeId) {
    const byProject = new Map(projects.map(p => [p.id, []]));
    vendors.slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).forEach(v => byProject.get(v.project_id)?.push(v));
    const raw = {
      version: 2,
      activeProjectId: projects.some(p => p.id === activeId) ? activeId : projects[0].id,
      projects: projects.slice().sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(p => ({
        id: p.id,
        project: { name: p.name, deadline: p.deadline || '', days: p.days, title: p.title || undefined, stages: p.stages || {}, categoryTasks: p.category_tasks || {}, warrantyYears: p.warranty_years ?? null },
        vendors: byProject.get(p.id).map(v => ({ id: v.id, name: v.name, category: v.category, contact: v.contact, phone: v.phone, email: v.email, note: v.note, noQuote: v.no_quote, dates: v.dates || {} }))
      })),
      vendorBook: book.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(b => b.profile)
    };
    return app.M.validateWorkspace(raw);
  }

  // ---------- 上傳 ----------
  function schedule() {
    if (mode !== 'synced' && mode !== 'syncing' && mode !== 'error') return false;
    clearTimeout(pushTimer); pushTimer = setTimeout(push, 400);
    setMode('syncing');
    return true;
  }
  async function push() {
    if (!sb || !session) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      const rows = currentRows();
      const upserts = { projects: [], vendors: [], vendor_book: [] }, deletes = { projects: [], vendors: [], vendor_book: [] };
      const sent = new Map();
      for (const [key, { table, row }] of rows) {
        const json = stable(row);
        if (synced.get(key) !== json) { upserts[table].push({ ...row, updated_at: new Date().toISOString(), ...(table !== 'vendor_book' ? { updated_by: session.user.email } : {}) }); sent.set(key, json); }
      }
      for (const key of synced.keys()) if (!rows.has(key)) { const [table, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]; deletes[table].push(id); }
      if (upserts.projects.length) await upsertProjects(upserts.projects);
      if (upserts.vendors.length) await check(sb.from('vendors').upsert(upserts.vendors));
      if (upserts.vendor_book.length) await check(sb.from('vendor_book').upsert(upserts.vendor_book));
      if (deletes.vendors.length) await check(sb.from('vendors').delete().in('id', deletes.vendors));
      if (deletes.vendor_book.length) await check(sb.from('vendor_book').delete().in('key', deletes.vendor_book));
      if (deletes.projects.length) await check(sb.from('projects').delete().in('id', deletes.projects));
      for (const [key, json] of sent) synced.set(key, json);
      for (const table of Object.keys(deletes)) for (const id of deletes[table]) synced.delete(table + ':' + id);
      setMode('synced');
    } catch (error) {
      console.error('雲端同步失敗', error);
      setMode('error', error);
      clearTimeout(pushTimer); pushTimer = setTimeout(push, 15000);
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; push(); }
    }
  }
  // 資料庫若還沒新增 warranty_years 欄位，先略過保固期限，其他資料照常同步。
  let skipWarranty = false;
  async function upsertProjects(rows) {
    const strip = list => list.map(row => { const out = { ...row }; delete out.warranty_years; return out; });
    if (skipWarranty) return check(sb.from('projects').upsert(strip(rows)));
    try { return await check(sb.from('projects').upsert(rows)); }
    catch (error) {
      if (!/warranty_years/.test(String(error?.message))) throw error;
      skipWarranty = true; console.warn('資料庫尚未新增 warranty_years 欄位，保固期限暫不同步');
      return check(sb.from('projects').upsert(strip(rows)));
    }
  }
  async function check(promise) { const { data, error } = await promise; if (error) throw error; return data; }

  // ---------- 下載與即時更新 ----------
  async function fetchAll() {
    const [projects, vendors, book] = await Promise.all([
      check(sb.from('projects').select('*')),
      check(sb.from('vendors').select('*')),
      check(sb.from('vendor_book').select('*'))
    ]);
    // 欄位尚未建立時，雲端資料沒有 warranty_years：沿用本機的保固期限，避免被清空
    for (const row of projects) {
      if (!('warranty_years' in row)) { skipWarranty = true; row.warranty_years = app.workspace.projects.find(p => p.id === row.id)?.project.warrantyYears ?? null; }
    }
    return { projects, vendors, book };
  }
  const pendingLocal = (key, rows) => { const local = rows.get(key); return (local ? stable(local.row) : undefined) !== synced.get(key); };
  // 把雲端最新內容合併進來；本機還沒上傳的變更保留（之後上傳時以本機為準）。
  function mergeRemote(data) {
    const rows = currentRows();
    const remote = new Map();
    data.projects.forEach(r => remote.set(keyOf('projects', r), clean(r)));
    data.vendors.forEach(r => remote.set(keyOf('vendors', r), clean(r)));
    data.book.forEach(r => remote.set(keyOf('vendor_book', r), { key: r.key, profile: r.profile }));
    const projects = [], vendors = [], book = [];
    const keys = new Set([...rows.keys(), ...remote.keys(), ...synced.keys()]);
    let changed = false;
    for (const key of keys) {
      const table = key.slice(0, key.indexOf(':'));
      let row;
      if (pendingLocal(key, rows)) row = rows.get(key)?.row; // 本機優先
      else { row = remote.get(key); const before = rows.get(key); if ((before ? stable(before.row) : '') !== (row ? stable(row) : '')) changed = true; if (row) synced.set(key, stable(row)); else synced.delete(key); }
      if (!row) continue;
      if (table === 'projects') projects.push(row); else if (table === 'vendors') vendors.push(row); else book.push({ ...row, updated_at: data.book.find(b => b.key === row.key)?.updated_at || '' });
    }
    if (!changed) return;
    if (!projects.length) return; // 雲端被清空時不覆寫本機，避免誤刪
    const liveVendors = vendors.filter(v => projects.some(p => p.id === v.project_id));
    app.replaceWorkspace(workspaceFromRows(projects, liveVendors, book, app.workspace.activeProjectId), { remote: true });
  }
  let refreshTimer = null;
  function refreshSoon(delay = 250) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!sb || !session || (mode !== 'synced' && mode !== 'syncing' && mode !== 'error')) return;
      try { mergeRemote(await fetchAll()); if (mode === 'error') setMode('synced'); } catch (error) { setMode('error', error); }
    }, delay);
  }
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    let first = true;
    channel = sb.channel('tender-quote-checklist')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => refreshSoon())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vendors' }, () => refreshSoon())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vendor_book' }, () => refreshSoon(800))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, () => { if ($('#cloud-dialog')?.open) loadMembers(); })
      .subscribe(status => { if (status === 'SUBSCRIBED') { if (!first) refreshSoon(0); first = false; } });
  }

  // ---------- 登入流程 ----------
  async function start(newSession) {
    session = newSession;
    if (!session) { stop(); setMode('signed-out'); return; }
    setMode('checking');
    try {
      const isMember = await check(sb.rpc('is_member'));
      if (!isMember) { setMode('not-member'); return; }
      const data = await fetchAll();
      synced = new Map();
      if (!data.projects.length) {
        const local = app.workspace, vendorsCount = local.projects.reduce((t, p) => t + p.vendors.length, 0);
        const upload = vendorsCount === 0 || confirm(`雲端目前還沒有資料。\n要把這台裝置上的 ${local.projects.length} 個案件、${vendorsCount} 間廠商上傳，讓團隊一起使用嗎？\n（選「取消」會從空白開始，這台裝置的資料仍可從「匯出與備份」下載）`);
        if (!upload) { saveLocalCopy(); app.replaceWorkspace(app.M.emptyWorkspace(), { initial: true }); }
        setMode('syncing'); await push();
      } else {
        const local = app.workspace;
        if (local.projects.some(p => p.vendors.length)) saveLocalCopy();
        data.projects.forEach(r => synced.set(keyOf('projects', r), stable(clean(r))));
        data.vendors.forEach(r => synced.set(keyOf('vendors', r), stable(clean(r))));
        data.book.forEach(r => synced.set(keyOf('vendor_book', r), stable({ key: r.key, profile: r.profile })));
        const liveVendors = data.vendors.filter(v => data.projects.some(p => p.id === v.project_id));
        const next = workspaceFromRows(data.projects, liveVendors, data.book, local.activeProjectId);
        // 合併：這台裝置上「雲端還沒有」的案件，詢問後一起上傳；雲端只有空白案件時順手移除
        const meaningful = entry => entry.vendors.length > 0 || entry.project.name.trim() !== '' || Object.values(entry.project.stages || {}).some(Boolean);
        const cloudIds = new Set(next.projects.map(p => p.id));
        const localOnly = local.projects.filter(p => !cloudIds.has(p.id) && meaningful(p));
        if (localOnly.length) {
          const vendorCount = localOnly.reduce((t, p) => t + p.vendors.length, 0);
          const names = localOnly.slice(0, 5).map(p => '・' + (p.project.name.trim() || '未命名案件')).join('\n') + (localOnly.length > 5 ? `\n…等 ${localOnly.length} 個` : '');
          if (confirm(`這台裝置有 ${localOnly.length} 個案件（${vendorCount} 間廠商）還沒在雲端：\n${names}\n\n要一起上傳，和團隊共用嗎？\n（選「取消」只顯示雲端資料，這台裝置的原資料會另存備份）`)) {
            next.projects = [...next.projects.filter(meaningful), ...localOnly];
            next.vendorBook = app.M.buildVendorBook(next.projects, [...next.vendorBook, ...(local.vendorBook || [])]);
            if (!next.projects.some(p => p.id === next.activeProjectId)) next.activeProjectId = local.projects.some(p => p.id === local.activeProjectId && localOnly.includes(p)) ? local.activeProjectId : next.projects[0].id;
          }
        }
        app.replaceWorkspace(next, { initial: true });
        setMode('synced');
        schedule(); // 若資料經過格式整理而與雲端略有差異，順手補上傳
      }
      subscribe();
    } catch (error) { console.error(error); setMode('error', error); }
  }
  function stop() { if (channel && sb) sb.removeChannel(channel); channel = null; synced = new Map(); clearTimeout(pushTimer); }
  function saveLocalCopy() { try { localStorage.setItem(LOCAL_COPY_KEY, JSON.stringify(app.workspace)); } catch (error) { /* 略過 */ } }

  // ---------- 畫面 ----------
  const labels = {
    off: ['local', '只存在此瀏覽器'],
    'signed-out': ['local', '登入以跨裝置同步'],
    checking: ['busy', '連線中…'],
    'not-member': ['warn', '尚未加入團隊'],
    syncing: ['busy', '同步中…'],
    synced: ['ok', '已同步到雲端'],
    error: ['warn', '同步失敗，稍後重試']
  };
  function setMode(next, error) {
    mode = next;
    const [tone, text] = labels[mode];
    const pill = $('#cloud-status');
    if (pill) { pill.className = 'cloud-pill ' + tone; $('#cloud-status-text').textContent = text; pill.title = error?.message || text; pill.hidden = mode === 'off'; }
    const footer = $('#storage-footer');
    if (footer) footer.textContent = ['synced', 'syncing', 'error'].includes(mode) ? '資料存在雲端 · 團隊成員跨裝置同步' : '自動儲存於此瀏覽器 · 不跨裝置同步';
    const status = $('#save-status');
    if (status && ['synced', 'syncing', 'error'].includes(mode)) status.textContent = text;
    if ($('#cloud-dialog')?.open) renderDialog();
  }
  function renderDialog() {
    const body = $('#cloud-body');
    if (!session) {
      body.innerHTML = `<p class="cloud-intro">輸入你的 Email，系統會寄一封登入信。點信中的連結，或把信裡的 6 位數驗證碼填在下方即可登入。</p>
        <form id="cloud-email-form" class="cloud-form"><label>Email<input name="email" type="email" required autocomplete="email" placeholder="name@company.com"></label><button class="btn primary" type="submit">寄送登入信</button></form>
        <form id="cloud-code-form" class="cloud-form hidden"><label>驗證碼<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required placeholder="信中的數字驗證碼"></label><button class="btn primary" type="submit">登入</button></form>
        <p class="cloud-note">只有團隊成員名單內的 Email 能看到資料。</p>`;
      return;
    }
    const email = session.user.email;
    const statusText = labels[mode][1];
    body.innerHTML = `<div class="cloud-account"><div><span class="eyebrow">已登入</span><strong>${esc(email)}</strong><small>${esc(statusText)}</small></div><button type="button" class="btn secondary" id="cloud-signout">登出</button></div>
      ${mode === 'not-member' ? `<p class="warning">你的 Email 還不在團隊成員名單內，看不到共用資料。請已加入的同事在這個視窗的「團隊成員」把 <b>${esc(email)}</b> 加進來，再重新整理頁面。</p>` : `
      <h3 class="cloud-h3">團隊成員 <span>${members.length} 人</span></h3>
      <ul class="member-list">${members.map(m => `<li><span>${esc(m.email)}${m.email === email.toLowerCase() ? ' <em>（你）</em>' : ''}</span><button type="button" class="link-btn" data-remove-member="${esc(m.email)}">移除</button></li>`).join('')}</ul>
      <form id="member-form" class="cloud-form"><label>新增成員 Email<input name="email" type="email" required placeholder="同事的 Email"></label><button class="btn secondary" type="submit">加入團隊</button></form>
      <p class="cloud-note">加入後，請同事打開這個網址，用該 Email 登入即可。</p>`}`;
  }
  async function loadMembers() {
    if (!session || mode === 'not-member') { members = []; return renderDialog(); }
    try { members = await check(sb.from('members').select('email, added_at').order('added_at')); } catch (error) { members = []; }
    renderDialog();
  }
  let pendingEmail = '';
  function bindDialog() {
    const dialog = $('#cloud-dialog');
    $('#cloud-status').addEventListener('click', () => { renderDialog(); dialog.showModal(); loadMembers(); });
    dialog.querySelectorAll('.close-cloud-dialog').forEach(b => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        if (form.id === 'cloud-email-form') {
          pendingEmail = form.elements.email.value.trim().toLowerCase();
          const redirect = location.origin + location.pathname;
          const { error } = await sb.auth.signInWithOtp({ email: pendingEmail, options: { emailRedirectTo: redirect } });
          if (error) throw error;
          app.toast(`登入信已寄到 ${pendingEmail}，請收信`);
          $('#cloud-code-form').classList.remove('hidden');
          $('#cloud-code-form input').focus();
        } else if (form.id === 'cloud-code-form') {
          const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: form.elements.code.value.trim(), type: 'email' });
          if (error) throw error;
          dialog.close();
        } else if (form.id === 'member-form') {
          const email = form.elements.email.value.trim().toLowerCase();
          await check(sb.from('members').insert({ email }));
          app.toast(`已把 ${email} 加入團隊`); await loadMembers();
        }
      } catch (error) {
        app.toast(friendly(error));
      } finally { button.disabled = false; }
    });
    dialog.addEventListener('click', async event => {
      if (event.target.id === 'cloud-signout') { await sb.auth.signOut(); dialog.close(); app.toast('已登出，資料改為只存在此瀏覽器'); return; }
      const email = event.target.dataset?.removeMember;
      if (email) {
        const self = email === session.user.email.toLowerCase();
        if (!confirm(self ? '確定把自己移出團隊嗎？移除後你將看不到共用資料。' : `確定把 ${email} 移出團隊嗎？`)) return;
        try { await check(sb.from('members').delete().eq('email', email)); app.toast(`已移除 ${email}`); await loadMembers(); } catch (error) { app.toast(friendly(error)); }
      }
    });
  }
  function friendly(error) {
    const msg = String(error?.message || error);
    if (/rate limit|security purposes/i.test(msg)) return '寄信太頻繁，請等一分鐘後再試';
    if (/expired|invalid/i.test(msg)) return '驗證碼錯誤或已過期，請重新寄送';
    if (/duplicate key/i.test(msg)) return '這個 Email 已經在團隊裡了';
    if (/fetch|network/i.test(msg)) return '連不上雲端，請檢查網路';
    return '發生錯誤：' + msg;
  }

  // ---------- 啟動 ----------
  function init(api) {
    app = api;
    setMode(mode);
    if (!enabled) return;
    bindDialog();
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
    let lastUser = null;
    sb.auth.onAuthStateChange((event, newSession) => {
      const user = newSession?.user?.id || null;
      if (user === lastUser && event !== 'SIGNED_OUT') { session = newSession; return; } // 只是更新權杖
      lastUser = user;
      setTimeout(() => start(newSession), 0);
    });
    window.addEventListener('online', () => { if (session) { refreshSoon(0); schedule(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && session) refreshSoon(0); });
  }
  window.CloudSync = { init, schedule, get active() { return ['synced', 'syncing', 'error'].includes(mode); } };
})();
