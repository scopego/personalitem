#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const NOTION_VERSION = "2022-06-28";
const ROOT_DIR = path.resolve(__dirname, "..");
const GENERATED_DIR = path.join(ROOT_DIR, "data", "generated");
const DEFAULT_ENV_PATH = path.join(ROOT_DIR, ".env");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

loadEnvFile(DEFAULT_ENV_PATH);

const config = {
  token: process.env.NOTION_TOKEN,
  articlesSourceId: process.env.NOTION_ARTICLES_SOURCE_ID,
  momentsSourceId: process.env.NOTION_MOMENTS_SOURCE_ID,
  mediaSourceId: process.env.NOTION_MEDIA_SOURCE_ID,
  siteConfigSourceId: process.env.NOTION_SITE_CONFIG_SOURCE_ID,
  scheduleSourceId: process.env.NOTION_SCHEDULE_SOURCE_ID,
};

main().catch((error) => {
  console.error(`Notion sync failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const [articles, moments, mediaRows, siteConfigRows, scheduleRows] = await Promise.all([
    queryDataSource(config.articlesSourceId),
    queryDataSource(config.momentsSourceId),
    queryDataSource(config.mediaSourceId),
    queryOptionalDataSource(config.siteConfigSourceId),
    queryOptionalDataSource(config.scheduleSourceId),
  ]);

  const output = {
    articles: articles.map(mapArticle).filter(Boolean),
    moments: moments.map(mapMoment).filter(Boolean),
    media: groupMediaByMonth(mediaRows.map(mapMedia).filter(Boolean)),
    siteConfig: mapSiteConfig(siteConfigRows),
    schedule: scheduleRows.map(mapSchedule).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };

  output.articles.sort((a, b) => compareDateDesc(a.date, b.date));
  output.moments.sort((a, b) => compareDateDesc(`${a.date}T${a.time || "00:00"}`, `${b.date}T${b.time || "00:00"}`));

  if (dryRun) {
    console.log(JSON.stringify({
      articles: output.articles.length,
      moments: output.moments.length,
      mediaItems: output.media.reduce((count, group) => count + group.items.length, 0),
      mediaGroups: output.media.length,
      schedule: output.schedule.length,
    }, null, 2));
    return;
  }

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  writeJson("articles.json", output.articles);
  writeJson("moments.json", output.moments);
  writeJson("media.json", output.media);
  writeJson("site-config.json", output.siteConfig);
  writeJson("schedule.json", output.schedule);
  writeJs("articles.generated.js", "window.generatedArticlesData", output.articles);
  writeJs("moments.generated.js", "window.generatedMomentsData", output.moments);
  writeJs("media.generated.js", "window.generatedMediaData", output.media);
  writeJs("site-config.generated.js", "window.generatedSiteConfig", output.siteConfig);
  writeJs("schedule.generated.js", "window.generatedScheduleData", output.schedule);

  console.log(`Synced ${output.articles.length} articles, ${output.moments.length} moments, ${output.media.reduce((count, group) => count + group.items.length, 0)} media items.`);
}

async function queryOptionalDataSource(sourceId) {
  if (!sourceId) return [];

  try {
    return await queryDataSource(sourceId);
  } catch (error) {
    console.warn(`Optional Notion source unavailable: ${sourceId}. ${error.message}`);
    return [];
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function validateConfig({ token, articlesSourceId, momentsSourceId, mediaSourceId }) {
  const missing = [];
  if (!token) missing.push("NOTION_TOKEN");
  if (!articlesSourceId) missing.push("NOTION_ARTICLES_SOURCE_ID");
  if (!momentsSourceId) missing.push("NOTION_MOMENTS_SOURCE_ID");
  if (!mediaSourceId) missing.push("NOTION_MEDIA_SOURCE_ID");

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
  }
}

async function queryDataSource(dataSourceId) {
  const results = [];
  let startCursor;

  do {
    const payload = startCursor ? { start_cursor: startCursor } : {};
    const response = await fetch(`https://api.notion.com/v1/data_sources/${normalizeId(dataSourceId)}/query`, {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Notion query failed for ${dataSourceId}: ${response.status} ${detail}`);
    }

    const data = await response.json();
    results.push(...(data.results || []));
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);

  return results.filter((page) => getSelectName(page, "Status") !== "Hidden" && getSelectName(page, "Status") !== "Archived");
}

function notionHeaders() {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function normalizeId(value) {
  return String(value || "").replace(/^collection:\/\//, "").trim();
}

function mapArticle(page) {
  const title = getTitle(page, "Title");
  if (!title) return null;

  const content = blocksToArticleContent(page);
  const date = getDateStart(page, "PublishedAt") || getDateStart(page, "SortDate") || "";

  return {
    id: getRichText(page, "Slug") || slugify(title),
    title,
    date,
    updatedAt: getDateStart(page, "UpdatedAt") || date,
    category: getSelectName(page, "Folder") || "随笔",
    summary: getRichText(page, "Summary"),
    tags: getRelationNames(page, "Tags"),
    content,
  };
}

function mapMoment(page) {
  const title = getTitle(page, "Title");
  const publishedAt = getDateStart(page, "PublishedAt") || getDateStart(page, "SortDate");
  const dateTime = splitDateTime(publishedAt);
  if (!title || !dateTime.date) return null;

  const localPhotos = getLocalAssetList(page, "LocalPhotos", "assets/images/moments");
  const notionPhotos = getFiles(page, "Photos").map((file) => ({
    src: file.url,
    alt: file.name || title,
    shape: "wide",
  }));

  return {
    id: title,
    date: dateTime.date,
    time: dateTime.time,
    text: getRichText(page, "Content"),
    location: getRichText(page, "Location"),
    weather: getSelectName(page, "Weather") || getRichText(page, "Weather"),
    photos: [...localPhotos, ...notionPhotos],
    notes: [],
  };
}

function mapMedia(page) {
  const title = getTitle(page, "Title");
  if (!title) return null;

  const finishedAtRaw = getDateStart(page, "FinishedAt") || getDateStart(page, "SortDate") || "";
  const finishedDateTime = splitDateTime(finishedAtRaw);
  const finishedAt = normalizeDateOnly(finishedAtRaw);
  const cover = getFiles(page, "Cover")[0];
  const localPoster = getLocalAssetPath(getRichText(page, "LocalPoster"), "assets/images/movies");

  return {
    month: finishedAt ? finishedAt.slice(0, 7).replace("-", ".") : "未归档",
    item: {
      date: finishedAt,
      time: finishedDateTime.time,
      type: getSelectName(page, "Type") || "综合",
      title,
      creator: getRichText(page, "Creator"),
      review: getRichText(page, "Review"),
      cover: "a",
      url: getUrl(page, "SourceURL") || "#",
      poster: localPoster || cover?.url || "",
      rating: getNumber(page, "Rating"),
    },
  };
}

function mapSchedule(page) {
  const date = normalizeDateOnly(getFirstDateStart(page, ["Date", "日期", "SortDate", "PublishedAt"]) || "");
  const shift = getFirstOptionText(page, ["Shift", "班次", "排班", "Name", "Title"]);
  const visible = getFirstCheckbox(page, ["Visible", "显示", "Show", "Public"]);
  if (!date || !shift || visible === false) return null;

  return {
    id: page.id,
    date,
    shift,
    note: getFirstRichText(page, ["Note", "备注", "说明"]),
  };
}

function blocksToArticleContent(page) {
  const markdown = page.properties?.Content?.rich_text
    ? getRichText(page, "Content")
    : "";

  if (!markdown) {
    return [
      {
        type: "paragraph",
        text: "正文将在接入 Notion 页面块读取后同步。",
      },
    ];
  }

  return markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith("## ")) return { type: "heading", text: part.replace(/^##\s+/, "") };
      if (part.startsWith("> ")) return { type: "quote", text: part.replace(/^>\s+/, "") };
      if (part.startsWith("- ")) {
        return {
          type: "list",
          items: part.split(/\n/).map((line) => line.replace(/^-\s+/, "").trim()).filter(Boolean),
        };
      }
      return { type: "paragraph", text: part };
    });
}

function groupMediaByMonth(rows) {
  const groups = new Map();

  rows.forEach(({ month, item }) => {
    if (!groups.has(month)) {
      groups.set(month, { month, items: [] });
    }
    groups.get(month).items.push(item);
  });

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => compareDateDesc(a.date, b.date)),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function mapSiteConfig(pages = []) {
  const values = new Map();

  pages.forEach((page) => {
    if (getCheckbox(page, "Visible") === false) return;
    const key = getTitle(page, "Key");
    const rawValue = getRichText(page, "Value");
    if (!key || !rawValue) return;
    values.set(key, parseSiteConfigValue(rawValue, getSelectName(page, "Type")));
  });

  return {
    activeMomentStatus: normalizeMomentStatusConfig(
      values.get("momentStatus.current") || values.get("currentMomentStatus"),
    ),
  };
}

function parseSiteConfigValue(value, type) {
  if (type === "json") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeMomentStatusConfig(value) {
  if (!value || typeof value !== "object") return null;
  const text = String(value.text || "").trim();
  if (!text) return null;
  return {
    id: String(value.id || "notion-current-status"),
    emoji: String(value.emoji || ""),
    text,
    updatedAt: String(value.updatedAt || "今天"),
  };
}

function getProperty(page, name) {
  return page.properties?.[name];
}

function getTitle(page, name) {
  const property = getProperty(page, name);
  return (property?.title || []).map((item) => item.plain_text || "").join("").trim();
}

function getFirstTitleByNames(page, names) {
  return names.map((name) => getTitle(page, name)).find(Boolean) || "";
}

function getRichText(page, name) {
  const property = getProperty(page, name);
  return (property?.rich_text || []).map((item) => item.plain_text || "").join("").trim();
}

function getFirstRichText(page, names) {
  return names.map((name) => getRichText(page, name)).find(Boolean) || "";
}

function getSelectName(page, name) {
  const property = getProperty(page, name);
  return property?.select?.name || property?.status?.name || "";
}

function getFirstOptionText(page, names) {
  return names
    .map((name) => getSelectName(page, name) || getRichText(page, name) || getTitle(page, name))
    .find(Boolean) || getFirstTitleByNames(page, names);
}

function getNumber(page, name) {
  return getProperty(page, name)?.number ?? null;
}

function getCheckbox(page, name) {
  const property = getProperty(page, name);
  if (!property || property.checkbox == null) return null;
  return Boolean(property.checkbox);
}

function getFirstCheckbox(page, names) {
  for (const name of names) {
    const value = getCheckbox(page, name);
    if (value !== null) return value;
  }
  return null;
}

function getUrl(page, name) {
  return getProperty(page, name)?.url || "";
}

function getDateStart(page, name) {
  return getProperty(page, name)?.date?.start || "";
}

function getFirstDateStart(page, names) {
  return names.map((name) => getDateStart(page, name)).find(Boolean) || "";
}

function normalizeDateOnly(value) {
  return String(value || "").split("T")[0];
}

function getFiles(page, name) {
  const property = getProperty(page, name);
  return (property?.files || []).map((file) => ({
    name: file.name || "",
    url: file.type === "external" ? file.external?.url : file.file?.url,
  })).filter((file) => file.url);
}

function getLocalAssetList(page, name, basePath) {
  return splitLocalAssetValue(getRichText(page, name)).map((value) => ({
    src: getLocalAssetPath(value, basePath),
    alt: value,
    shape: "wide",
  })).filter((photo) => photo.src);
}

function splitLocalAssetValue(value) {
  return String(value || "")
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getLocalAssetPath(value, basePath) {
  const path = String(value || "").trim();
  if (!path) return "";
  if (/^(https?:)?\/\//.test(path) || path.startsWith("/") || path.startsWith("assets/")) return path;
  return `${basePath}/${path}`;
}

function getRelationNames() {
  // Notion's public relation payload only includes page IDs in the API response.
  // Tag name expansion will be added after the basic sync path is stable.
  return [];
}

function splitDateTime(value) {
  if (!value) return { date: "", time: "22:27" };
  const [date, timePart] = value.split("T");
  const time = timePart ? timePart.slice(0, 5) : "22:27";
  return { date, time };
}

function compareDateDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function writeJson(filename, data) {
  fs.writeFileSync(path.join(GENERATED_DIR, filename), `${JSON.stringify(data, null, 2)}\n`);
}

function writeJs(filename, globalName, data) {
  fs.writeFileSync(path.join(GENERATED_DIR, filename), `${globalName} = ${JSON.stringify(data, null, 2)};\n`);
}
