# GitHub Pages 博客完全指南

> 基于 Astro + GitHub Actions 的个人博客部署方案。

---

## 一、GitHub Pages 是什么

GitHub Pages 是 GitHub 提供的静态站点托管服务，免费、零运维。它把你的 `dist/` 构建产物部署到 CDN，通过 `用户名.github.io/仓库名` 访问。

**限制**：
- 免费账户只能公开仓库使用 Pages
- 每月 100GB 流量上限
- 只支持静态站点（不能跑 Node.js/PHP/Python 后端）

---

## 二、从零搭建到上线的完整流程

### 1. 本地项目结构

```
blog/
├── .github/workflows/deploy.yml   # GitHub Actions 部署流程
├── astro.config.mjs              # Astro 配置（site + base 路径）
├── src/
│   ├── content/blog/             # 文章放这里（Markdown/MDX）
│   ├── pages/                    # 页面
│   ├── components/               # 组件
│   └── layouts/                  # 布局模板
├── public/                       # 静态资源（favicon 等）
└── package.json
```

### 2. 关键配置：`astro.config.mjs`

```js
export default defineConfig({
  site: 'https://amazing36.github.io',  // 你的 GitHub Pages 域名
  base: '/spinach-blog',                 // 仓库名（user 站点需要，独立域名不需要）
});
```

> **注意**：如果你用 `用户名.github.io` 仓库（如 `amazing36.github.io`），`base` 设为 `'/'`。如果放在子仓库（如 `blog`），`base` 设为 `'/仓库名'`。

### 3. GitHub Actions 工作流 `.github/workflows/deploy.yml`

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/deploy-pages@v4
```

### 4. 开启 GitHub Pages（第一次必须手动）

1. 打开仓库 → **Settings** → **Pages**
2. Source 选择 **GitHub Actions**
3. 保存后，下一次 push 或 workflow_dispatch 就会自动部署

> 也可以通过 API 操作（需要 `gh` CLI 已认证）：
> ```bash
> # 开启 Pages
> echo '{"source":{"branch":"main","path":"/"}}' | gh api repos/用户名/仓库名/pages --method POST --input -
> ```

---

## 三、日常操作

### 写新文章

```bash
# 在 src/content/blog/ 下新建 Markdown 文件
# 格式参考已有的 first-post.md
---
title: "文章标题"
description: "文章摘要"
pubDate: 2026-04-23
---

正文内容...
```

### 本地预览

```bash
cd D:\projects\blog
npm run dev
# 浏览器打开 http://localhost:4321/spinach-blog
```

### 部署到线上

```bash
git add .
git commit -m "feat: 新增文章 xxx"
git push origin main
# GitHub Actions 自动触发构建和部署
```

### 查看部署状态

1. 打开仓库 → **Actions** 标签页
2. 点击最近的 workflow run，查看 build 和 deploy 阶段状态
3. 成功后访问 `https://用户名.github.io/仓库名/`

### 手动触发部署（不 push 代码时）

```bash
gh workflow run deploy.yml --ref main
```

---

## 四、关闭 / 下线 / 撤销部署

### 场景 1：暂时不让外部访问（下线）

1. 打开 **Settings → Pages**
2. 点击 **"Unpublish site"** 按钮
3. 站点立即从 CDN 下线（CDN 缓存最多 10 分钟过期）

> CDN 缓存刷新：GitHub Pages 默认 `Cache-Control: max-age=600`（10 分钟），变更后可能需要 10-30 分钟 CDN 才会刷新。强制刷新浏览器（Ctrl+F5）可绕过本地缓存。

### 场景 2：切换 Source 为 None

1. **Settings → Pages**
2. Build and deployment 的 Source 下拉选 **None**
3. 保存

### 场景 3：仓库改回私有（免费账户自动关闭 Pages）

```bash
# 用 gh CLI（需要先认证）
gh api repos/用户名/仓库名 --method PATCH --field private=true
```

### 场景 4：彻底删除 GitHub Pages

1. **Settings → Pages** → 拉到最下面点击 **"Delete GitHub Pages site"**
2. 或者直接删除整个仓库

---

## 五、恢复上线

之前下线/私有化后，想重新公开：

```bash
# 1. 改回公开仓库
gh api repos/用户名/仓库名 --method PATCH --field private=false

# 2. 开启 Pages
echo '{"source":{"branch":"main","path":"/"}}' | gh api repos/用户名/仓库名/pages --method POST --input -

# 3. 触发部署
gh workflow run deploy.yml --ref main

# 4. 或者 push 代码触发
git push origin main
```

---

## 六、绑定自定义域名

1. 在你的域名注册商（阿里云/Cloudflare 等）添加 DNS 记录：
   - CNAME：`www` → `用户名.github.io`
   - A 记录：`@` → `185.199.108.153` / `185.199.109.153` / `185.199.110.153` / `185.199.111.153`
2. **Settings → Pages → Custom domain**，输入你的域名
3. 勾选 **Enforce HTTPS**
4. 更新 `astro.config.mjs` 中的 `site` 为你的域名，`base` 改为 `'/'`

---

## 七、常见问题和排查

| 问题 | 解决 |
|------|------|
| 部署失败 404 | 确认 Pages 已开启（Source 选了 GitHub Actions） |
| push 后页面没更新 | CDN 缓存，等 10 分钟或 Ctrl+F5 硬刷新 |
| 图片/字体 404 | 检查 `base` 路径配置是否正确 |
| 私有仓库无法用 Pages | 免费账户不支持，改为公开或用 Pro |
| Workflow 报错 Node.js 20 | 加 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` 环境变量 |

---

## 八、参考链接

### 官方文档
- [GitHub Pages Quickstart](https://docs.github.com/pages/quickstart)
- [Creating a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Unpublishing a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/unpublishing-a-github-pages-site)
- [Deleting a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/deleting-a-github-pages-site)
- [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)

### GitHub Actions 部署
- [actions/deploy-pages](https://github.com/actions/deploy-pages) — 官方部署 Action
- [actions/upload-pages-artifact](https://github.com/actions/upload-pages-artifact) — 上传构建产物

### 社区指南
- [Setting Up GitHub Pages with GitHub Actions (DEV)](https://dev.to/jajera/setting-up-github-pages-with-github-actions-2o72)
- [GitHub Pages CDN caching discussion](https://github.com/orgs/community/discussions/11884)
- [GitHub serving old page / cache issue](https://github.com/orgs/community/discussions/49753)
- [How to remove GitHub Pages](https://webapps.stackexchange.com/questions/8512/how-to-remove-github-pages)

---

## 九、本项目快速参考

| 路径 | 说明 |
|------|------|
| `D:\projects\blog` | 项目根目录 |
| `src/content/blog/` | 文章目录 |
| `npm run dev` | 本地预览 |
| `npm run build` | 构建静态文件 |
| `git push origin main` | 触发自动部署 |
| 部署地址 | `https://amazing36.github.io/spinach-blog/` |
