#!/usr/bin/env node
/**
 * 今天吃什么 · Supabase 数据初始化/迁移脚本（开发工具，勿部署到前端）
 * ---------------------------------------------------------------------
 * 功能：
 *   1. 检测 Supabase 连通性与 dishes / pick_history 表是否存在；
 *   2. 将仓库根目录 data.txt 中的旧数据批量导入云端（按 name+store 幂等去重）；
 *   3. 打印迁移结果。
 *
 * 使用：
 *   - 需要 Node.js >= 18
 *   - 首次使用先复制 .env.example 为 .env 并填入 SUPABASE_SECRET_KEY
 *   - 运行： node scripts/setup.mjs
 *
 * 注意：
 *   - 本脚本使用 SECRET_KEY（等同 service_role，拥有最高权限），
 *     严禁提交 .env 到公开仓库！
 *   - 表结构请先在 Supabase Dashboard SQL Editor 执行 supabase/migration.sql
 * ---------------------------------------------------------------------
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ---------- 读取配置（.env -> 环境变量） ----------
function loadEnv() {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const URL = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!URL || !SECRET) {
  console.error('❌ 缺少配置：请先复制 .env.example 为 .env 并填写 SUPABASE_URL / SUPABASE_SECRET_KEY');
  process.exit(1);
}

const REST = URL.replace(/\/+$/, '') + '/rest/v1';
const HEADERS = {
  apikey: SECRET,
  Authorization: 'Bearer ' + SECRET,
  'Content-Type': 'application/json'
};

// ---------- 小工具 ----------
async function rest(path, { method = 'GET', body } = {}) {
  const res = await fetch(REST + path, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const err = new Error(typeof data === 'string' ? `HTTP ${res.status}` : (data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- 主流程 ----------
async function main() {
  console.log('🌐 目标 Supabase:', URL);

  // 1. 连通性检测
  try {
    await rest('/dishes?select=id&limit=1');
    console.log('   ✅ 项目连通，密钥有效');
  } catch (e) {
    console.error(`   ❌ 连接失败（HTTP ${e.status || '?'}）：${e.message}`);
    if (e.status === 401) {
      console.error('\n   ⚠️  返回 401：项目可能已暂停或密钥失效。');
      console.error('      请到 https://supabase.com/dashboard 恢复项目（Restore project），并核对 API Keys。');
    }
    process.exit(1);
  }

  // 2. 检查表是否存在
  let dishesOk = true, historyOk = true;
  try { await rest('/dishes?select=id&limit=1'); } catch { dishesOk = false; }
  try { await rest('/pick_history?select=id&limit=1'); } catch { historyOk = false; }
  if (!dishesOk || !historyOk) {
    console.error('   ❌ 表不存在（dishes:', dishesOk, '/ pick_history:', historyOk, '）');
    console.error('      请在 Supabase Dashboard -> SQL Editor 中执行 supabase/migration.sql 后再运行本脚本。');
    process.exit(1);
  }

  // 3. 读取 data.txt
  const dataPath = join(root, 'data.txt');
  if (!existsSync(dataPath)) {
    console.warn('   ⚠️  未找到 data.txt，跳过数据导入。');
    return;
  }
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
  const dishes = data.dishes || [];
  const history = data.history || [];
  console.log(`   📄 读取 data.txt：${dishes.length} 个菜谱，${history.length} 条历史`);

  // 4. 导入菜谱（幂等：同 name+store 视为重复，做合并更新）
  let inserted = 0, merged = 0;
  for (const d of dishes) {
    const q = encodeURIComponent(`name=eq.${d.name}`);
    const existing = await rest(`/dishes?select=*&${q}&limit=5`);
    const dup = (existing || []).find((x) => (x.store || '') === (d.store || ''));
    if (dup) {
      const patch = {};
      if (!dup.note && d.note) patch.note = d.note;
      if (!dup.category && d.category) patch.category = d.category;
      if (dup.price == null && d.price != null) patch.price = Number(d.price);
      patch.pick_count = Math.max(dup.pick_count || 0, d.pickCount || d.pick_count || 0);
      if ((d.lastPicked || d.last_picked) && (!dup.last_picked || (d.lastPicked || d.last_picked) > dup.last_picked)) {
        patch.last_picked = d.lastPicked || d.last_picked;
      }
      await rest(`/dishes?id=eq.${dup.id}`, { method: 'PATCH', body: patch });
      merged++;
      console.log(`   🔀 合并: ${d.name}`);
    } else {
      await rest('/dishes', {
        method: 'POST',
        body: {
          name: d.name,
          store: d.store || '',
          category: d.category || '',
          price: d.price == null ? null : Number(d.price),
          note: d.note || '',
          pick_count: d.pickCount || d.pick_count || 0,
          last_picked: d.lastPicked || d.last_picked || null,
          created_at: d.createdAt || d.created_at || new Date().toISOString()
        }
      });
      inserted++;
      console.log(`   ➕ 新增: ${d.name}`);
    }
  }
  console.log(`   ✅ 菜谱导入完成：新增 ${inserted}，合并 ${merged}`);

  // 5. 导入历史（按 id 去重，保留最近 200 条）
  if (history.length) {
    const existing = (await rest('/pick_history?select=id&limit=1000')) || [];
    const existingIds = new Set(existing.map((h) => h.id));
    let hImported = 0;
    for (const h of history.slice(0, 200)) {
      if (existingIds.has(h.id)) continue;
      await rest('/pick_history', {
        method: 'POST',
        body: {
          id: h.id,
          dish_id: h.dishId || h.dish_id || null,
          dish_name: h.name || h.dish_name || '未知',
          dish_store: h.store || h.dish_store || '',
          dish_category: h.category || h.dish_category || '',
          created_at: h.date || h.created_at || new Date().toISOString()
        }
      });
      hImported++;
    }
    console.log(`   ✅ 历史导入完成：新增 ${hImported} 条`);
  }

  console.log('\n🎉 迁移完成！打开网站即可看到云端数据。');
}

main().catch((e) => {
  console.error('❌ 迁移失败：', e.message);
  process.exit(1);
});
