/* =====================================================================
 * 今天吃什么 · 伪前后端网页系统
 * ---------------------------------------------------------------------
 * 架构说明：
 *   data.txt 与 index.html 同级，存放 JSON 格式数据，充当"服务端数据库"。
 *   页面加载时 fetch('data.txt') 模拟 GET 请求读取云端数据；
 *   本地所有增删改先写入 localStorage（模拟写库，实时生效），
 *   通过"导出 data.txt / 导入 data.txt"完成与仓库的云同步。
 * ===================================================================== */

(function () {
  'use strict';

  // ---------- 常量 ----------
  var STORAGE_KEY = 'what2eat_db_v1';
  var DATA_FILE = 'data.txt';
  var CATEGORY_KEY = 'what2eat_categories_v1';
  var DEFAULT_CATEGORIES = ['正餐', '快餐', '小吃', '饮品', '夜宵'];

  // ---------- 状态 ----------
  var db = { version: 1, updatedAt: null, dishes: [], history: [] };
  var categories = [];
  var currentCategory = '全部';
  var editingId = null;
  var localVersion = null;   // 本地 localStorage 中的数据版本（若有）
  var serverVersion = null;  // data.txt 中的数据版本（若有）

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 工具 ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function now() {
    return new Date().toISOString();
  }

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

  // ---------- 本地存储（模拟写库） ----------
  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLocal() {
    db.updatedAt = now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  }

  // ---------- 读取 data.txt（模拟 GET /data） ----------
  function fetchRemote() {
    return fetch(DATA_FILE, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var data = JSON.parse(text);
        serverVersion = data;
        return data;
      });
  }

  // ---------- 初始化 ----------
  function init() {
    bindEvents();
    loadCategories();

    Promise.all([fetchRemote()])
      .then(function (results) {
        localVersion = loadLocal();
        var remote = results[0];

        if (localVersion && Array.isArray(localVersion.dishes) && localVersion.dishes.length >= 0) {
          // 本地有数据（用户改过）：以本地为准，标记"本地较新"
          db = localVersion;
          setSyncStatus('local', '本地数据较新 · 已离线保存');
          toast('已载入本地数据（未同步到云端 data.txt）');
        } else if (remote && Array.isArray(remote.dishes)) {
          // 本地无数据：读取云端 data.txt
          db = remote;
          db.history = remote.history || [];
          setSyncStatus('online', '已同步云端 data.txt');
        } else {
          db = { version: 1, updatedAt: now(), dishes: [], history: [] };
          setSyncStatus('online', '云端无数据，开始你的第一个菜谱吧');
        }
        renderAll();
      })
      .catch(function (err) {
        // data.txt 读取失败：离线模式，用本地数据或空数据兜底
        localVersion = loadLocal();
        if (localVersion && Array.isArray(localVersion.dishes)) {
          db = localVersion;
          setSyncStatus('local', '离线模式 · 使用本地数据');
        } else {
          db = { version: 1, updatedAt: now(), dishes: [], history: [] };
          setSyncStatus('offline', '离线模式 · 数据将仅保存在本机');
        }
        renderAll();
        console.warn('读取 data.txt 失败（可能本地直接打开的 file:// 模式）：', err);
      });
  }

  function loadCategories() {
    try {
      var raw = localStorage.getItem(CATEGORY_KEY);
      categories = raw ? JSON.parse(raw) : [];
    } catch (e) {
      categories = [];
    }
    if (!categories || categories.length === 0) {
      categories = DEFAULT_CATEGORIES.slice();
    }
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
  }

  function renderFilterChips() {
    var bar = $('filterChips');
    // 汇总所有分类（来自菜品 + 已有分类）
    var cats = categories.slice();
    db.dishes.forEach(function (d) {
      if (d.category && cats.indexOf(d.category) === -1) cats.push(d.category);
    });
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

    var html = dishes.map(function (d) {
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
              '<button class="icon-btn" data-act="edit" data-id="' + d.id + '" title="编辑">✏️</button>' +
              '<button class="icon-btn danger" data-act="del" data-id="' + d.id + '" title="删除">🗑️</button>' +
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

    list.innerHTML = html;

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
    var result = $('pickResult');
    var hasAny = db.dishes.length > 0;
    if (!hasAny) {
      $('pickEmpty').classList.remove('hidden');
      $('pickDetail').classList.add('hidden');
      $('btnPick').classList.remove('hidden');
      $('btnRePick').classList.add('hidden');
      return;
    }
    $('pickEmpty').classList.add('hidden');
    $('btnPick').classList.remove('hidden');
    $('btnRePick').classList.add('hidden');
    $('pickDetail').classList.add('hidden');
    result.querySelector('.pick-detail') && result.querySelector('.pick-detail').classList.add('hidden');
    // 无选中状态时显示默认提示
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

    // 加权随机：被选次数越少，被抽中概率越高
    var total = pool.reduce(function (s, d) { return s + Math.max(1, 10 - (d.pickCount || 0)); }, 0);
    var r = Math.random() * total;
    var pickedDish = null;
    for (var i = 0; i < pool.length; i++) {
      r -= Math.max(1, 10 - (pool[i].pickCount || 0));
      if (r <= 0) { pickedDish = pool[i]; break; }
    }
    if (!pickedDish) pickedDish = pool[pool.length - 1];

    // 若同一次里连续抽到同一个（可重抽场景），轻微惩罚：再随机一次
    var last = db.history[0];
    if (last && last.dishId === pickedDish.id && pool.length > 1) {
      var others = pool.filter(function (d) { return d.id !== pickedDish.id; });
      pickedDish = others[Math.floor(Math.random() * others.length)];
    }

    // 更新数据
    pickedDish.pickCount = (pickedDish.pickCount || 0) + 1;
    pickedDish.lastPicked = now();
    db.history.unshift({
      id: uid(),
      date: now(),
      dishId: pickedDish.id,
      name: pickedDish.name,
      store: pickedDish.store || '',
      category: pickedDish.category || ''
    });
    if (db.history.length > 200) db.history.length = 200;

    saveLocal();
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
    var cats = categories.slice();
    db.dishes.forEach(function (d) {
      if (d.category && cats.indexOf(d.category) === -1) cats.push(d.category);
    });
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
          fillCategorySelect(name);
          saveLocal();
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
        d.name = name;
        d.store = store;
        d.category = category;
        d.price = price;
        d.note = note;
        toast('已更新：' + name + ' ✅');
      }
    } else {
      db.dishes.push({
        id: uid(),
        name: name,
        store: store,
        category: category,
        price: price,
        note: note,
        pickCount: 0,
        lastPicked: null,
        createdAt: now()
      });
      toast('已添加：' + name + ' 🎉');
    }

    if (category && categories.indexOf(category) === -1) categories.push(category);
    saveLocal();
    closeDishModal();
    renderAll();
  }

  // ---------- 删除 ----------
  function deleteDish(id) {
    var d = db.dishes.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    if (!confirm('确定要删除「' + d.name + '」吗？')) return;
    db.dishes = db.dishes.filter(function (x) { return x.id !== id; });
    saveLocal();
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

  // ---------- 导出 / 导入 data.txt ----------
  function exportData() {
    var data = {
      version: 2,
      updatedAt: now(),
      app: '今天吃什么',
      tips: '此文件为伪后端数据库，与 index.html 同级。编辑后请保持 JSON 格式合法，上传替换仓库中的 data.txt 即可同步给所有访客。',
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
    toast('已导出 data.txt，上传到仓库即可云同步 ☁️');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var text = ev.target.result;
        // 去掉可能的 BOM
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var data = JSON.parse(text);
        if (!data.dishes || !Array.isArray(data.dishes)) {
          throw new Error('数据中没有 dishes 数组');
        }
        db = {
          version: data.version || 2,
          updatedAt: now(),
          dishes: data.dishes,
          history: Array.isArray(data.history) ? data.history : []
        };
        saveLocal();
        closeDataModal();
        renderAll();
        setSyncStatus('local', '导入成功 · 本地数据已更新');
        toast('导入成功，共 ' + db.dishes.length + ' 个菜谱 ✅');
      } catch (err) {
        toast('导入失败：' + err.message + ' ❌');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // ---------- 同步状态 ----------
  function setSyncStatus(state, text) {
    var el = $('syncStatus');
    el.className = 'sync-status' + (state ? ' ' + state : '');
    $('syncText').textContent = text;
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  // ---------- 弹窗开关 ----------
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
    $('btnClearHistory').addEventListener('click', function () {
      if (!confirm('确定清空所有选择历史吗？')) return;
      db.history = [];
      saveLocal();
      renderHistory();
      renderSyncStats();
      toast('历史记录已清空');
    });

    $('btnOpenData').addEventListener('click', openDataModal);
    $('btnCloseData').addEventListener('click', closeDataModal);
    $('btnExport').addEventListener('click', exportData);
    $('fileImport').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });

    // 点击遮罩关闭弹窗
    document.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    // 键盘快捷键
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeDishModal(); closeDataModal(); closeHistoryModal();
      }
    });
  }

  // ---------- 启动 ----------
  document.addEventListener('DOMContentLoaded', init);
})();
