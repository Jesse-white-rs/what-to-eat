# 🍜 今天吃什么

一个选择困难症终结者的网页应用，部署于 GitHub Pages，数据存储于 **Supabase 云数据库**（PostgreSQL）。

## ✨ 功能

- 🎲 **一键随机选餐**：加权随机，被选次数少的更容易被抽中，不满意可"再来一次"
- 📝 **自定义菜谱**：自由添加菜名、店名、分类、价格和备注，支持编辑与删除
- 🗂️ **分类筛选**：正餐 / 快餐 / 小吃 / 饮品 / 夜宵，可自定义分类
- 📜 **选择历史**：云端记录每一次随机结果
- ☁️ **云同步**：所有设备共享同一份数据，无需手动同步
- 📡 **离线降级**：云不可用时自动切换本地模式，变更排队，恢复后自动同步

## 🏗️ 架构

```
┌─────────────────┐   HTTPS / PostgREST REST API   ┌─────────────────┐
│  GitHub Pages   │ ─────────────────────────────▶ │    Supabase     │
│  (静态前端)      │   apikey: publishable_key      │  PostgreSQL     │
│  index.html     │ ◀───────────────────────────── │  - dishes       │
│  script.js      │         JSON 响应               │  - pick_history │
└─────────────────┘                                └─────────────────┘
        │  localStorage（离线镜像 + 变更队列）
        ▼
   浏览器端离线模式
```

- **前端**：`script.js` 内置轻量 PostgREST 客户端（零依赖 fetch），仅使用公开的 **publishable key**；
- **数据库**：Supabase 两张表 `dishes`（菜谱）与 `pick_history`（选择历史），RLS 匿名读写策略；
- **离线**：云不可用（项目暂停/断网/401）时自动降级到 `localStorage`，变更进入离线队列，云恢复后自动回放。

## 🔑 密钥说明

| 密钥 | 使用位置 | 是否可公开 |
|---|---|---|
| `SUPABASE_PUBLISHABLE_KEY` | 前端 `script.js` | ✅ 可公开（本就是公开密钥） |
| `SUPABASE_SECRET_KEY` | 仅本地 `scripts/setup.mjs`（`.env`） | ❌ 严禁提交/内置前端 |

## 🚀 首次部署指南

### 1. 初始化数据库（需在 Supabase 控制台操作一次）
1. 登录 https://supabase.com/dashboard ，打开项目 `eajpuqbmtlcuxtkhawfn`；
2. 若项目处于 **Paused** 状态，先点击 **Restore project** 恢复；
3. 进入 **SQL Editor** → New query → 粘贴并运行 [`supabase/migration.sql`](supabase/migration.sql)（建表 + 索引 + RLS 匿名策略）。

### 2. 迁移旧数据（可选）
```bash
# 准备配置（只填 secret key）
copy .env.example .env

# 安装 Node 依赖前无需安装任何包，直接运行（Node >= 18）
node scripts/setup.mjs
```
脚本会把仓库根目录 `data.txt` 中的菜谱与历史批量导入云端（幂等去重）。

### 3. 本地预览
直接用浏览器打开 `index.html`，或使用静态服务器：
```bash
npx serve .
```

## 🌐 在线访问

部署完成后访问：

```
https://<用户名>.github.io/<仓库名>/
```

## 🗂️ 项目结构

```
├── index.html              # 前端页面
├── styles.css              # 样式
├── script.js               # 逻辑 + PostgREST 数据层
├── data.txt                # 数据备份文件（可导入恢复 / 供迁移脚本读取）
├── supabase/
│   └── migration.sql       # 数据库初始化 SQL（控制台执行）
├── scripts/
│   └── setup.mjs           # 旧数据迁移脚本（本地工具）
├── .env.example            # 本地环境变量模板
├── .gitignore              # 排除 .env 等敏感文件
└── .github/workflows/deploy.yml  # GitHub Pages 自动部署
```

## 📝 License

MIT
