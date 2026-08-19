-- =============================================================================
-- 今天吃什么 · Supabase 数据库初始化脚本
-- -----------------------------------------------------------------------------
-- 使用方法：
--   1. 登录 https://supabase.com/dashboard
--   2. 打开项目 -> SQL Editor -> New query
--   3. 粘贴本文件全部内容并 Run
-- 说明：本脚本可重复执行（幂等），再次执行会保留已有数据。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 扩展（uuid 生成）
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 2. 菜谱表 dishes
-- -----------------------------------------------------------------------------
create table if not exists public.dishes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  store       text not null default '',
  category    text not null default '',
  price       numeric,
  note        text not null default '',
  pick_count  integer not null default 0,
  last_picked timestamptz,
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. 选择历史表 pick_history
-- -----------------------------------------------------------------------------
create table if not exists public.pick_history (
  id           uuid primary key default gen_random_uuid(),
  dish_id      uuid,
  dish_name    text not null,
  dish_store   text not null default '',
  dish_category text not null default '',
  created_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. 索引
-- -----------------------------------------------------------------------------
create index if not exists idx_dishes_category on public.dishes (category);
create index if not exists idx_pick_history_created_at on public.pick_history (created_at desc);

-- -----------------------------------------------------------------------------
-- 5. 行级安全（RLS）
--    站点为公开共享"今天吃什么"，匿名（anon）用户可读写。
-- -----------------------------------------------------------------------------
alter table public.dishes enable row level security;
alter table public.pick_history enable row level security;

drop policy if exists "dishes_public_all" on public.dishes;
create policy "dishes_public_all"
  on public.dishes
  for all
  using (true)
  with check (true);

drop policy if exists "pick_history_public_all" on public.pick_history;
create policy "pick_history_public_all"
  on public.pick_history
  for all
  using (true)
  with check (true);

-- 授权给 anon / authenticated / service_role（默认已授权，这里显式声明确保安全兜底）
grant all on public.dishes to anon, authenticated, service_role;
grant all on public.pick_history to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. 可选：种子数据（首次初始化时使用；已有数据时不会重复插入）
--    执行后由 scripts/setup.mjs 导入 data.txt 中的数据，或手动删除下方种子。
-- -----------------------------------------------------------------------------
-- 如已有数据，跳过此段。默认不插入种子，改用迁移脚本导入旧数据。
-- 如需纯 SQL 种子，可取消注释以下示例：
--
-- insert into public.dishes (name, store, category, price, note, pick_count)
-- values ('麻辣香锅', '张亮麻辣烫（步行街店）', '正餐', 38, '中辣，加宽粉和午餐肉', 2)
-- on conflict do nothing;
