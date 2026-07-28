# 22:27 Notion Sync

这个目录先放一层 Notion CMS 同步骨架。它不会直接改动当前页面，也不会把现有 `app.js` 和 `moments-data.js` 替换掉。

## 使用方式

1. 复制 `.env.example` 为 `.env`
2. 在 Notion 创建 Integration，复制 Internal Integration Secret 到 `NOTION_TOKEN`
3. 确认 `.env` 里的三个 Data Source ID：
   - `NOTION_ARTICLES_SOURCE_ID`
   - `NOTION_MOMENTS_SOURCE_ID`
   - `NOTION_MEDIA_SOURCE_ID`
4. 在 Notion 里把 Articles、Moments、Media 三个数据库分享给这个 Integration
5. 先运行预览：

```bash
npm run sync:notion:dry
```

6. 确认数量正常后运行：

```bash
npm run sync:notion
```

同步结果会生成到：

- `data/generated/articles.json`
- `data/generated/moments.json`
- `data/generated/media.json`
- `data/generated/articles.generated.js`
- `data/generated/moments.generated.js`
- `data/generated/media.generated.js`

## 当前边界

- 这一步只是同步骨架，网站页面仍然读取现有本地数据。
- Notion 页面正文块的完整读取还没有接入；目前文章正文优先读取数据库字段里的 `Content`，没有则使用占位段落。
- Notion 关系字段返回的是页面 ID，标签名称展开会在后续适配层里补。
- 本地图片路径不能被 Notion API 自动读取。后续可以选择在 Notion 上传图片，或在 Notion 中填写本地文件名。

## 后续接入思路

稳定后再让页面按以下优先级读取：

1. 如果存在 `window.generatedArticlesData`，优先使用 Notion 生成数据。
2. 否则继续使用当前 `app.js` 中的手写数据。

这样 Notion 同步失败时，网站不会白屏。

## Vercel 自动更新方案

现在项目已经包含：

- `api/content.js`：Vercel 后台接口，安全读取 Notion。
- `lib/notion-content.js`：把 Notion 数据转换成网站使用的数据结构。
- `app.js`：页面启动时会先尝试读取 `/api/content`，失败时继续使用本地数据。

部署到 Vercel 后，你只需要在 Vercel 项目里添加这些 Environment Variables：

- `NOTION_TOKEN`
- `NOTION_ARTICLES_SOURCE_ID`
- `NOTION_MOMENTS_SOURCE_ID`
- `NOTION_MEDIA_SOURCE_ID`
- `NOTION_SITE_CONFIG_SOURCE_ID`（可选，用于读取「此刻状态」等站点配置）

当前三个数据库 ID 是：

- `NOTION_ARTICLES_SOURCE_ID=791dab33-3e08-44e7-be50-32999a1a8a22`
- `NOTION_MOMENTS_SOURCE_ID=f127c184-3eb3-485f-807a-bd9636b8663c`
- `NOTION_MEDIA_SOURCE_ID=6ef32171-3c27-42bf-a241-3bb275da4718`
- `NOTION_SITE_CONFIG_SOURCE_ID=11206174-be7c-4817-ac8a-515f40496a36`

之后日常更新流程就是：

1. 在 Notion 写内容。
2. 把内容状态设为 `Published`。
3. 刷新网站。
4. 网站通过 `/api/content` 读取最新 Notion 内容。

Notion Token 只存在于 Vercel 后台，不会出现在浏览器里。

## 字段说明

### Media

- `FinishedAt`：作品完成日期。网站影集浮层中的日期使用这个字段，不再按作品顺序自动生成 7/1、7/2。
- `Rating`：数字评分，支持 `1`、`1.5`、`2`、`2.5`、`3`、`3.5`、`4`、`4.5`、`5`。
- `LocalPoster`：本地封面路径。图片放在 `assets/images/movies/` 后，这里可以只填文件名，例如 `ghost-palace.webp`。如果填完整路径，例如 `assets/images/movies/ghost-palace.webp`，也可以。

### Moments

- `Weather`：天气下拉选项。网站会把它显示在每条片刻的时分旁边。
- `LocalPhotos`：本地图片路径。图片放在 `assets/images/moments/` 后，这里可以填一个或多个文件名。多张图用换行、逗号或分号分隔。

例如：

```text
walk-01.jpg
walk-02.jpg
walk-03.jpg
```

可选值：

- `☀️ 晴`
- `🌤️ 多云`
- `☁️ 阴`
- `🌫️ 雾霾`
- `🌧️ 小雨`
- `⛈️ 雷雨`
- `❄️ 下雪`
- `🌬️ 大风`
- `🌈 雨后`
- `🌙 夜晚`
- `🔥 炎热`
- `❄️ 寒冷`

### SiteConfig

如果需要从 Notion 控制片刻页面右侧栏「此刻状态」，在 SiteConfig 新增或编辑这一行：

- `Key`：`momentStatus.current`
- `Type`：`json`
- `Visible`：勾选
- `Value`：

```json
{"id":"notion-current-status","emoji":"🙂","text":"正在整理网站。","updatedAt":"今天"}
```

之后只需要修改 `emoji`、`text`、`updatedAt`，网站刷新后会读取这条配置。
