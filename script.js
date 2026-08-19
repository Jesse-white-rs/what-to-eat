/* =====================================================================
 * 今天吃什么 · Supabase 云数据库版
 * ---------------------------------------------------------------------
 * 架构：
 *   - 数据源：Supabase（PostgreSQL），前端通过 PostgREST REST API 直连
 *   - 密钥：仅使用 PUBLISHABLE（公开）密钥；SECRET 密钥绝不进入前端代码
 *   - 离线降级：云不可用时自动切换本地模式，变更进入"离线变更队列"，
 *     云恢复后自动回放同步
 *   - 兼容旧版：自动迁移 v1（data.txt + localStorage）数据到云端
 * ===================================================================== */

(function () {
  'use strict';

  // ---------- Supabase 配置（publishable 密钥，公开安全） ----------
  var SUPABASE_URL = 'https://eajpuqbmtlcuxtkhawfn.supabase.co';
  var SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fxuBQ9pXdUCA5fifKDMYOA_dEERskPC';
  var REST_BASE = SUPABASE_URL + '/rest/v1';

  // ---------- 常量 ----------
  var MIRROR_KEY = 'what2eat_db_v2';
  var QUEUE_KEY = 'what2eat_queue_v2';
  var OLD_KEY = 'what2eat_db_v1';
  var OLD_CAT_KEY = 'what2eat_categories_v1';
  var DEFAULT_CATEGORIES = ['正餐', '快餐', '小吃', '饮品', '夜宵'];
  var HISTORY_LIMIT = 200;

  // ---------- 状态 ----------
  var mode = 'checking';          // checking | cloud | local
  var db = { dishes: [], history: [] };
  var queue = [];                 // 离线变更队列
  var categories = [];
  var currentCategory = '全部';
  var editingId = null;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 工具 ----------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  function now() { return new Date().toISOString(); }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shortErr(err) {
    if (!err) return '未知错误';
    if (err.status === 401) return '项目未激活/密钥失效';
    if (err.name === 'TimeoutError' || /timeout/i.test(err.message || '')) return '连接超时';
    return err.message || '未知错误';
  }

  // ---------- 数据映射（camelCase ⇄ snake_case） ----------
  function fromDishRow(r) {
    return {
      id: r.id,
      name: r.name,
      store: r.store || '',
      category: r.category || '',
      price: r.price == null ? null : Number(r.price),
      note: r.note || '',
      pickCount: r.pick_count || 0,
      lastPicked: r.last_picked || null,
      createdAt: r.created_at || null
    };
  }

  function toDishRow(d) {
    return {
      id: d.id,
      name: d.name,
      store: d.store || '',
      category: d.category || '',
      price: d.price == null ? null : Number(d.price),
      note: d.note || '',
      pick_count: d.pickCount || 0,
      last_picked: d.lastPicked || null,
      created_at: d.createdAt || null
    };
  }

  function fromHistoryRow(h) {
    return {
      id: h.id,
      date: h.created_at,
      dishId: h.dish_id,
      name: h.dish_name,
      store: h.dish_store || '',
      category: h.dish_category || ''
    };
  }

  function toHistoryRow(h) {
    return {
      id: h.id,
      dish_id: h.dishId,
      dish_name: h.name,
      dish_store: h.store || '',
      dish_category: h.category || '',
      created_at: h.date
    };
  }

  // ---------- PostgREST 客户端（零依赖，fetch 直连） ----------
  function fetchTimeout(url, init, ms) {
    return Promise.race([
      fetch(url, init),
      new Promise(function (_, reject) {
        setTimeout(function () {
          var e = new Error('timeout');
          e.name = 'TimeoutError';
          reject(e);
        }, ms || 10000);
      })
    ]);
  }

  function rest(path, opts) {
    opts = opts || {};
    var headers = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_PUBLISHABLE_KEY
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.prefer) headers.Prefer = opts.prefer;
    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetchTimeout(REST_BASE + path, init, 10000).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = text; }
        }
        if (!res.ok) {
          var err = new Error(typeof data === 'string' ? 'HTTP ' + res.status : (data && data.message) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  var api = {
    check: function () {
      return rest('/dishes?select=id&limit=1');
    },
    listDishes: function () {
      return rest('/dishes?select=*&order=created_at.asc');
    },
    insertDish: function (d) {
      return rest('/dishes?select=*', { method: 'POST', prefer: 'return=representation', body: d });
    },
    updateDish: function (id, patch) {
      return rest('/dishes?select=*&id=eq.' + encodeURIComponent(id), { method: 'PATCH', prefer: 'return=representation', body: patch });
    },
    deleteDish: function (id) {
      return rest('/dishes?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    },
    deleteAllDishes: function () {
      return rest('/dishes?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    },
    listHistory: function () {
      return rest('/pick_history?select=*&order=created_at.desc&limit=' + HISTORY_LIMIT);
    },
    insertHistory: function (h) {
      return rest('/pick_history?select=*', { method: 'POST', prefer: 'return=representation', body: h });
    },
    clearHistory: function () {
      return rest('/pick_history?id=neq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
    }
  };

  // ---------- 本地镜像 & 离线队列 ----------
  function loadMirror() {
    try {
      var raw = localStorage.getItem(MIRROR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveMirror() {
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify({
        dishes: db.dishes,
        history: db.history,
        categories: categories,
        updatedAt: now()
      }));
    } catch (e) { /* 存储满时忽略 */ }
  }

  function loadQueue() {
    try {
      var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(q) ? q : [];
    } catch (e) { return []; }
  }

  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) { /* 忽略 */ }
  }

  function enqueue(op) {
    queue.push(op);
    saveQueue();
  }

  // ---------- 旧版数据迁移（v1 localStorage / data.txt） ----------
  function migrateLegacy() {
    try {
      var v1 = localStorage.getItem(OLD_KEY);
      if (v1 && !localStorage.getItem(MIRROR_KEY)) {
        var data = JSON.parse(v1);
        if (data && Array.isArray(data.dishes)) {
          var idMap = {};
          data.dishes.forEach(function (d) {
            if (!isUuid(d.id)) {
              var newId = uid();
              idMap[d.id] = newId;
              d.id = newId;
            }
          });
          (data.history || []).forEach(function (h) {
            if (h.dishId && idMap[h.dishId]) h.dishId = idMap[h.dishId];
            if (h.dishId && !isUuid(h.dishId)) h.dishId = null;
            if (!isUuid(h.id)) h.id = uid();
          });
          db.dishes = data.dishes;
          db.history = data.history || [];
          categories = (data.categories && data.categories.length) ? data.categories : DEFAULT_CATEGORIES.slice();
          saveMirror();
          queue = data.dishes.map(function (d) { return { type: 'insertDish', data: d }; });
          saveQueue();
          localStorage.removeItem(OLD_KEY);
          localStorage.removeItem(OLD_CAT_KEY);
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 云连接与模式切换 ----------
  function setMode(m) {
    mode = m;
    if (m === 'cloud') {
      $('syncStatus').className = 'sync-status online';
      $('syncText').textContent = '云同步正常 · Supabase 已连接';
      $('offlineBanner').classList.add('hidden');
    } else if (m === 'local') {
      $('syncStatus').className = 'sync-status offline';
      $('syncText').textContent = '离线模式 · 云数据库不可用';
      $('offlineText').textContent = '云数据库不可用，当前为本地离线模式。你做的更改已保存，云恢复后自动同步（当前待同步 ' + queue.length + ' 条）';
      $('offlineBanner').classList.remove('hidden');
    } else {
      $('syncStatus').className = 'sync-status';
      $('syncText').textContent = '连接云数据库…';
    }
    renderSyncStats();
  }

  function connectCloud() {
    setMode('checking');
    api.check()
      .then(function () {
        mode = 'cloud';
        return Promise.all([api.listDishes(), api.listHistory()]);
      })
      .then(function (results) {
        var dishes = (results[0] || []).map(fromDishRow);
        var history = (results[1] || []).map(fromHistoryRow);
        db.dishes = dishes;
        db.history = history;
        saveMirror();
        return flushQueue();
      })
      .then(function () {
        setMode('cloud');
        renderAll();
        toast('☁️ 已连接云端数据库');
      })
      .catch(function (err) {
        setMode('local');
        renderAll();
        toast('⚠️ 云数据库不可用：' + shortErr(err));
        console.warn('Supabase 连接失败：', err);
      });
  }

  function downgrade(msg) {
    if (mode !== 'local') {
      setMode('local');
      toast('⚠️ ' + msg);
    }
  }

  // ---------- 离线队列回放 ----------
  function dedupeInsert(dish) {
    return api.listDishes().then(function (all) {
      var dup = (all || []).filter(function (x) {
        return x.name === dish.name && (x.store || '') === (dish.store || '');
      })[0];
      if (dup) {
        var patch = {};
        if (!dup.note && dish.note) patch.note = dish.note;
        if (!dup.category && dish.category) patch.category = dish.category;
        if (dup.price == null && dish.price != null) patch.price = Number(dish.price);
        patch.pick_count = Math.max(dup.pick_count || 0, dish.pick_count || 0);
        if (dish.last_picked && (!dup.last_picked || dish.last_picked > dup.last_picked)) patch.last_picked = dish.last_picked;
        return api.updateDish(dup.id, patch).then(function () { return dup.id; });
      }
      return api.insertDish(dish).then(function (rows) {
        return rows && rows[0] ? rows[0].id : dish.id;
      });
    });
  }

  function replaceCloudData(data) {
    var dishes = (data.dishes || []).map(toDishRow);
    var history = (data.history || []).map(toHistoryRow);
    return api.deleteAllDishes()
      .then(function () {
        return Promise.all(dishes.map(function (d) { return api.insertDish(d).catch(function () { return null; }); }));
      })
      .then(function () { return api.clearHistory(); })
      .then(function () {
        return Promise.all(history.map(function (h) { return api.insertHistory(h).catch(function () { return null; }); }));
      });
  }

  function applyOp(op) {
    switch (op.type) {
      case 'insertDish': return dedupeInsert(op.data);
      case 'updateDish': return api.updateDish(op.data.id, op.data.patch);
      case 'deleteDish': return api.deleteDish(op.data.id);
      case 'insertHistory': return api.insertHistory(op.data);
      case 'clearHistory': return api.clearHistory();
      case 'importReplace': return replaceCloudData(op.data);
      default: return Promise.resolve();
    }
  }

  function flushQueue() {
    if (mode !== 'cloud' || queue.length === 0) return Promise.resolve();
    var pending = queue.slice();
    var done = [];
    var idx = 0;
    function step() {
      if (idx >= pending.length) {
        queue = queue.filter(function (item) { return done.indexOf(item) === -1; });
        saveQueue();
        return Promise.resolve();
      }
      var op = pending[idx];
      return applyOp(op).then(function () {
        done.push(op);
        idx++;
        return step();
      }).catch(function (e) {
        console.warn('离线队列回放失败（保留剩余）：', op, e);
        queue = queue.filter(function (item) { return done.indexOf(item) === -1; });
        saveQueue();
        return Promise.resolve();
      });
    }
    return step();
  }

  // ---------- 分类 ----------
  function loadCategories() {
    try {
      var m = loadMirror();
      if (m && m.categories && m.categories.length) return m.categories.slice();
    } catch (e) { /* 忽略 */ }
    return DEFAULT_CATEGORIES.slice();
  }

  function collectCategories() {
    var cats = categories.slice();
    db.dishes.forEach(function (d) {
      if (d.category && cats.indexOf(d.category) === -1) cats.push(d.category);
    });
    return cats;
  }

  // ---------- 渲染 ----------
  function renderAll() {
    renderSyncStats();
    renderFilterChips();
    renderDishList();
    renderPickResult();
    renderHistory();
  }

  function renderSyncStats() {
    $('statTotal').textContent = db.dishes.length;
    $('statPicked').textContent = db.dishes.reduce(function (s, d) { return s + (d.pickCount || 0); }, 0);
    $('statHistory').textContent = db.history.length;
    $('queueCount').textContent = queue.length;
    $('cloudStateText').textContent =
      mode === 'cloud' ? '已连接 Supabase（云数据库）' :
      mode === 'checking' ? '正在连接云数据库…' : '离线本地模式（待同步 ' + queue.length + ' 条）';
  }

  function renderFilterChips() {
    var bar = $('filterChips');
    var cats = collectCategories();
    var html = '';
    html += '<button class="chip' + (currentCategory === '全部' ? ' active' : '') + '" data-cat="全部">全部<span class="chip-count">' + db.dishes.length + '</span></button>';
    cats.forEach(function (c) {
      var count = db.dishes.filter(function (d) { return d.category === c; }).length;
      if (count === 0) return;
      html += '<button class="chip' + (currentCategory === c ? ' active' : '') + '" data-cat="' + escapeHtml(c) + '">' + escapeHtml(c) + '<span class="chip-count">' + count + '</span></button>';
    });
    bar.innerHTML = html;
    bar.querySelectorAll('.chip').forEach(function (el) {
      el.addEventListener('click', function () {
        currentCategory = el.getAttribute('data-cat');
        renderFilterChips();
        renderDishList();
        renderPickResult();
      });
    });
  }

  function getFilteredDishes() {
    if (currentCategory === '全部') return db.dishes;
    return db.dishes.filter(function (d) { return d.category === currentCategory; });
  }

  function renderDishList() {
    var list = $('dishList');
    var dishes = getFilteredDishes();
    var empty = $('emptyState');
    if (dishes.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.innerHTML = dishes.map(function (d) {
      var note = d.note ? '<div class="dish-card-note">💬 ' + escapeHtml(d.note) + '</div>' : '';
      var price = d.price ? '<span class="tag tag-price">¥' + Number(d.price).toFixed(0) + '</span>' : '';
      var store = d.store ? '<div class="dish-card-store">' + escapeHtml(d.store) + '</div>' : '';
      var category = d.category ? '<span class="tag">' + escapeHtml(d.category) + '</span>' : '';
      return '' +
        '<div class="dish-card">' +
          '<div class="dish-card-top">' +
            '<div>' +
              '<div class="dish-card-name">' + escapeHtml(d.name) + '</div>' +
              store +
            '</div>' +
            '<div class="dish-card-actions">' +
              '<button class="icon-btn" data-act="edit" data-id="' + escapeHtml(d.id) + '" title="编辑">✏️</button>' +
              '<button class="icon-btn danger" data-act="del" data-id="' + escapeHtml(d.id) + '" title="删除">🗑️</button>' +
            '</div>' +
          '</div>' +
          '<div class="dish-tags">' + category + price + '</div>' +
          note +
          '<div class="dish-card-footer">' +
            '<div class="dish-card-stats">' +
              '<span class="stat-pick">🎯 被选 ' + (d.pickCount || 0) + ' 次</span>' +
              (d.lastPicked ? '<span>最近 ' + formatDate(d.lastPicked) + '</span>' : '<span>还没被抽中过</span>') +
            '</div>' +
          '</div>' +
        '</div>';
    }).join('');
    list.querySelectorAll('.icon-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        var id = btn.getAttribute('data-id');
        if (act === 'edit') openEditDish(id);
        else if (act === 'del') deleteDish(id);
      });
    });
  }

  function renderPickResult() {
    $('pickEmpty').classList.remove('hidden');
    $('pickDetail').classList.add('hidden');
    $('btnPick').classList.remove('hidden');
    $('btnRePick').classList.add('hidden');
  }

  function showPickDetail(d) {
    $('pickEmpty').classList.add('hidden');
    var detail = $('pickDetail');
    detail.classList.remove('hidden');
    $('btnPick').classList.add('hidden');
    $('btnRePick').classList.remove('hidden');
    $('pickDishName').textContent = d.name;
    $('pickDishStore').textContent = d.store || '（无店名）';
    $('pickDishCategory').textContent = d.category || '未分类';
    $('pickDishPrice').textContent = d.price ? '约 ¥' + Number(d.price).toFixed(0) : '';
  }

  // ---------- 随机抽取 ----------
  function pickDish() {
    var pool = getFilteredDishes();
    if (pool.length === 0) {
      toast('当前分类下没有菜谱，换个分类或先添加吧 🍱');
      return;
    }
    var total = pool.reduce(function (s, d) { return s + Math.max(1, 10 - (d.pickCount || 0)); }, 0);
    var r = Math.random() * total;
    var pickedDish = null;
    for (var i = 0; i < pool.length; i++) {
      r -= Math.max(1, 10 - (pool[i].pickCount || 0));
      if (r <= 0) { pickedDish = pool[i]; break; }
    }
    if (!pickedDish) pickedDish = pool[pool.length - 1];

    var last = db.history[0];
    if (last && last.dishId === pickedDish.id && pool.length > 1) {
      var others = pool.filter(function (d) { return d.id !== pickedDish.id; });
      pickedDish = others[Math.floor(Math.random() * others.length)];
    }

    pickedDish.pickCount = (pickedDish.pickCount || 0) + 1;
    pickedDish.lastPicked = now();

    var entry = {
      id: uid(),
      date: now(),
      dishId: pickedDish.id,
      name: pickedDish.name,
      store: pickedDish.store || '',
      category: pickedDish.category || ''
    };
    db.history.unshift(entry);
    if (db.history.length > 300) db.history.length = 300;
    saveMirror();

    // 云写库
    var patch = { pick_count: pickedDish.pickCount, last_picked: pickedDish.lastPicked };
    if (mode === 'cloud') {
      api.updateDish(pickedDish.id, patch).catch(function () {
        enqueue({ type: 'updateDish', data: { id: pickedDish.id, patch: patch } });
        downgrade('离线已记录，云恢复后自动同步');
      });
      api.insertHistory(toHistoryRow(entry)).catch(function () {
        enqueue({ type: 'insertHistory', data: toHistoryRow(entry) });
      });
    } else {
      enqueue({ type: 'updateDish', data: { id: pickedDish.id, patch: patch } });
      enqueue({ type: 'insertHistory', data: toHistoryRow(entry) });
    }

    showPickDetail(pickedDish);
    renderDishList();
    renderSyncStats();
    renderHistory();
  }

  // ---------- 添加 / 编辑 ----------
  function openAddDish() {
    editingId = null;
    $('dishModalTitle').textContent = '🍳 添加菜谱';
    $('inputName').value = '';
    $('inputStore').value = '';
    $('inputPrice').value = '';
    $('inputNote').value = '';
    fillCategorySelect(currentCategory === '全部' ? '' : currentCategory);
    $('dishModal').classList.remove('hidden');
    setTimeout(function () { $('inputName').focus(); }, 50);
  }

  function openEditDish(id) {
    var d = db.dishes.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    editingId = id;
    $('dishModalTitle').textContent = '✏️ 编辑菜谱';
    $('inputName').value = d.name || '';
    $('inputStore').value = d.store || '';
    $('inputPrice').value = d.price || '';
    $('inputNote').value = d.note || '';
    fillCategorySelect(d.category || '');
    $('dishModal').classList.remove('hidden');
    setTimeout(function () { $('inputName').focus(); }, 50);
  }

  function fillCategorySelect(selected) {
    var sel = $('inputCategory');
    var cats = collectCategories();
    var html = '';
    cats.forEach(function (c) {
      html += '<option value="' + escapeHtml(c) + '"' + (c === selected ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    });
    html += '<option value="__new__">＋ 新建分类…</option>';
    sel.innerHTML = html;
    sel.value = selected || cats[0] || '';
    sel.addEventListener('change', function () {
      if (sel.value === '__new__') {
        var nc = prompt('请输入新分类名称：', '');
        if (nc && nc.trim()) {
          var name = nc.trim().slice(0, 10);
          if (categories.indexOf(name) === -1) categories.push(name);
          saveMirror();
          fillCategorySelect(name);
        } else {
          fillCategorySelect(selected);
        }
      }
    }, { once: true });
  }

  function submitDish(e) {
    e.preventDefault();
    var name = $('inputName').value.trim();
    if (!name) {
      toast('请填写菜名 🍜');
      $('inputName').focus();
      return;
    }
    var store = $('inputStore').value.trim();
    var category = $('inputCategory').value;
    if (category === '__new__') category = '';
    var priceVal = $('inputPrice').value;
    var price = priceVal === '' || isNaN(Number(priceVal)) ? null : Number(priceVal);
    var note = $('inputNote').value.trim();

    if (editingId) {
      var d = db.dishes.filter(function (x) { return x.id === editingId; })[0];
      if (d) {
        var old = { name: d.name, store: d.store };
        d.name = name;
        d.store = store;
        d.category = category;
        d.price = price;
        d.note = note;
        saveMirror();
        var patch = { name: name, store: store, category: category, price: price == null ? null : Number(price), note: note };
        if (mode === 'cloud') {
          api.updateDish(d.id, patch).catch(function () {
            enqueue({ type: 'updateDish', data: { id: d.id, patch: patch } });
            downgrade('修改已暂存本地，云恢复后自动同步');
          });
        } else {
          enqueue({ type: 'updateDish', data: { id: d.id, patch: patch } });
        }
        toast('已更新：' + name + ' ✅');
      }
    } else {
      var dish = {
        id: uid(),
        name: name,
        store: store,
        category: category,
        price: price,
        note: note,
        pickCount: 0,
        lastPicked: null,
        createdAt: now()
      };
      db.dishes.push(dish);
      saveMirror();
      if (mode === 'cloud') {
        api.insertDish(toDishRow(dish)).then(function (rows) {
          if (rows && rows[0]) {
            var row = rows[0];
            var idx = db.dishes.findIndex(function (x) { return x.id === dish.id; });
            if (idx >= 0) db.dishes[idx] = fromDishRow(row);
            saveMirror();
            renderDishList();
          }
        }).catch(function () {
          enqueue({ type: 'insertDish', data: toDishRow(dish) });
          downgrade('新增已暂存本地，云恢复后自动同步');
        });
      } else {
        enqueue({ type: 'insertDish', data: toDishRow(dish) });
      }
      toast('已添加：' + name + ' 🎉');
    }

    if (category && categories.indexOf(category) === -1) {
      categories.push(category);
      saveMirror();
    }
    closeDishModal();
    renderAll();
  }

  // ---------- 删除 ----------
  function deleteDish(id) {
    var d = db.dishes.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    if (!confirm('确定要删除「' + d.name + '」吗？')) return;
    db.dishes = db.dishes.filter(function (x) { return x.id !== id; });
    saveMirror();
    if (mode === 'cloud') {
      api.deleteDish(id).catch(function () {
        enqueue({ type: 'deleteDish', data: { id: id } });
        downgrade('删除已暂存本地，云恢复后自动同步');
      });
    } else {
      enqueue({ type: 'deleteDish', data: { id: id } });
    }
    renderAll();
    toast('已删除 ' + d.name + ' 🗑️');
  }

  // ---------- 历史 ----------
  function renderHistory() {
    var list = $('historyList');
    if (db.history.length === 0) {
      $('historyEmpty').classList.remove('hidden');
      list.innerHTML = '';
      return;
    }
    $('historyEmpty').classList.add('hidden');
    list.innerHTML = db.history.slice(0, 100).map(function (h) {
      return '<li class="history-item">' +
        '<span class="h-date">' + formatDate(h.date) + '</span>' +
        '<span class="h-name">' + escapeHtml(h.name) + '</span>' +
        '<span class="h-store">' + (h.store ? '📍 ' + escapeHtml(h.store) : '') + '</span>' +
        '</li>';
    }).join('');
  }

  function clearHistory() {
    if (!confirm('确定清空所有选择历史吗？（云端记录也会被清空）')) return;
    db.history = [];
    saveMirror();
    if (mode === 'cloud') {
      api.clearHistory().catch(function () {
        enqueue({ type: 'clearHistory', data: {} });
        downgrade('清空已暂存本地，云恢复后自动同步');
      });
    } else {
      enqueue({ type: 'clearHistory', data: {} });
    }
    renderHistory();
    renderSyncStats();
    toast('历史记录已清空');
  }

  // ---------- 备份导出 / 恢复导入 ----------
  function exportData() {
    var data = {
      version: 3,
      updatedAt: now(),
      app: '今天吃什么',
      source: 'supabase',
      tips: '此文件为数据备份（JSON）。可通过"导入备份"恢复，或上传 data.txt 作仓库种子。',
      dishes: db.dishes,
      history: db.history
    };
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob(['\ufeff' + json], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 100);
    toast('已导出备份 data.txt 💾');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var text = ev.target.result;
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var data = JSON.parse(text);
        if (!data.dishes || !Array.isArray(data.dishes)) throw new Error('数据中没有 dishes 数组');

        if (!confirm('导入将覆盖当前全部数据（共 ' + data.dishes.length + ' 个菜谱）。确定继续？')) return;

        var dishes = data.dishes.map(function (d) {
          return {
            id: isUuid(d.id) ? d.id : uid(),
            name: d.name,
            store: d.store || '',
            category: d.category || '',
            price: d.price == null ? null : Number(d.price),
            note: d.note || '',
            pickCount: d.pickCount || d.pick_count || 0,
            lastPicked: d.lastPicked || d.last_picked || null,
            createdAt: d.createdAt || d.created_at || now()
          };
        });
        var history = (data.history || []).map(function (h) {
          return {
            id: isUuid(h.id) ? h.id : uid(),
            date: h.date || h.created_at || now(),
            dishId: isUuid(h.dishId) ? h.dishId : (isUuid(h.dish_id) ? h.dish_id : null),
            name: h.name || h.dish_name || '未知',
            store: h.store || h.dish_store || '',
            category: h.category || h.dish_category || ''
          };
        });

        db.dishes = dishes;
        db.history = history;
        saveMirror();

        if (mode === 'cloud') {
          var payload = { dishes: dishes, history: history };
          replaceCloudData(payload).then(function () {
            toast('已导入并写入云端，共 ' + dishes.length + ' 个菜谱 ✅');
          }).catch(function (e) {
            enqueue({ type: 'importReplace', data: payload });
            downgrade('云端写入失败，已排队待同步');
          });
        } else {
          enqueue({ type: 'importReplace', data: { dishes: dishes, history: history } });
          toast('已导入本地，云恢复后将自动同步 ✅');
        }
        closeDataModal();
        renderAll();
      } catch (err) {
        toast('导入失败：' + err.message + ' ❌');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  // ---------- 弹窗 ----------
  function closeDishModal() { $('dishModal').classList.add('hidden'); }
  function openDataModal() { renderSyncStats(); $('dataModal').classList.remove('hidden'); }
  function closeDataModal() { $('dataModal').classList.add('hidden'); }
  function openHistoryModal() { renderHistory(); $('historyModal').classList.remove('hidden'); }
  function closeHistoryModal() { $('historyModal').classList.add('hidden'); }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    $('btnPick').addEventListener('click', pickDish);
    $('btnRePick').addEventListener('click', pickDish);

    $('btnAddDish').addEventListener('click', openAddDish);
    $('btnCloseDish').addEventListener('click', closeDishModal);
    $('btnCancelDish').addEventListener('click', closeDishModal);
    $('dishForm').addEventListener('submit', submitDish);

    $('btnHistory').addEventListener('click', openHistoryModal);
    $('btnCloseHistory').addEventListener('click', closeHistoryModal);
    $('btnClearHistory').addEventListener('click', clearHistory);

    $('btnOpenData').addEventListener('click', openDataModal);
    $('btnCloseData').addEventListener('click', closeDataModal);
    $('btnExport').addEventListener('click', exportData);
    $('btnRetryConnect').addEventListener('click', function () {
      toast('正在重试连接云数据库…');
      connectCloud();
    });
    $('fileImport').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });

    document.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeDishModal(); closeDataModal(); closeHistoryModal();
      }
    });
  }

  // ---------- 启动 ----------
  function init() {
    bindEvents();
    migrateLegacy();
    categories = loadCategories();
    var mirror = loadMirror();
    if (mirror && mirror.dishes) {
      db.dishes = mirror.dishes;
      db.history = mirror.history || [];
    }
    queue = loadQueue();
    setMode('checking');
    renderAll();
    connectCloud();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
