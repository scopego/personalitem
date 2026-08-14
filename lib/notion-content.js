const NOTION_VERSION = "2022-06-28";

function getNotionConfig(env = process.env) {
  return {
    token: env.NOTION_TOKEN,
    articlesSourceId: env.NOTION_ARTICLES_SOURCE_ID,
    momentsSourceId: env.NOTION_MOMENTS_SOURCE_ID,
    mediaSourceId: env.NOTION_MEDIA_SOURCE_ID,
    siteConfigSourceId: env.NOTION_SITE_CONFIG_SOURCE_ID,
    scheduleSourceId: env.NOTION_SCHEDULE_SOURCE_ID,
  };
}

function validateNotionConfig(config) {
  const missing = [];
  if (!config.token) missing.push("NOTION_TOKEN");
  if (!config.articlesSourceId) missing.push("NOTION_ARTICLES_SOURCE_ID");
  if (!config.momentsSourceId) missing.push("NOTION_MOMENTS_SOURCE_ID");
  if (!config.mediaSourceId) missing.push("NOTION_MEDIA_SOURCE_ID");

  if (missing.length) {
    throw new Error(`Missing Notion environment variables: ${missing.join(", ")}`);
  }
}

async function fetchNotionContent(config = getNotionConfig()) {
  validateNotionConfig(config);

  const client = createNotionClient(config.token);
  const [articlePages, momentPages, mediaPages, siteConfigPages, schedulePages] = await Promise.all([
    client.querySource(config.articlesSourceId),
    client.querySource(config.momentsSourceId),
    client.querySource(config.mediaSourceId),
    queryOptionalSource(client, config.siteConfigSourceId),
    queryOptionalSource(client, config.scheduleSourceId),
  ]);

  const tagResolver = createTagResolver(client);
  const articles = await Promise.all(articlePages.map((page) => mapArticle(page, client, tagResolver)));
  const moments = await Promise.all(momentPages.map((page) => mapMoment(page, tagResolver)));
  const mediaItems = await Promise.all(mediaPages.map((page) => mapMedia(page, tagResolver)));

  const content = {
    articles: articles.filter(Boolean).sort((a, b) => compareDateDesc(a.date, b.date)),
    moments: moments
      .filter(Boolean)
      .sort((a, b) => compareDateDesc(`${a.date}T${a.time || "00:00"}`, `${b.date}T${b.time || "00:00"}`)),
    media: groupMediaByMonth(mediaItems.filter(Boolean)),
    siteConfig: mapSiteConfig(siteConfigPages),
    schedule: schedulePages.map(mapSchedule).filter(Boolean).sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };

  return {
    ...content,
    meta: {
      source: "notion",
      syncedAt: new Date().toISOString(),
    },
  };
}

async function queryOptionalSource(client, sourceId) {
  if (!sourceId) return [];

  try {
    return await client.querySource(sourceId);
  } catch (error) {
    console.warn(`Optional Notion source unavailable: ${sourceId}. ${error.message}`);
    return [];
  }
}

function createNotionClient(token) {
  async function request(path, options = {}) {
    const response = await fetch(`https://api.notion.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Notion request failed: ${response.status} ${detail}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  return {
    async querySource(sourceId) {
      const cleanId = normalizeId(sourceId);
      const tryPaths = [`/v1/data_sources/${cleanId}/query`, `/v1/databases/${cleanId}/query`];
      const results = [];
      let pathIndex = 0;
      let startCursor;

      while (pathIndex < tryPaths.length) {
        try {
          do {
            const payload = startCursor ? { start_cursor: startCursor } : {};
            const data = await request(tryPaths[pathIndex], {
              method: "POST",
              body: JSON.stringify(payload),
            });
            results.push(...(data.results || []));
            startCursor = data.has_more ? data.next_cursor : undefined;
          } while (startCursor);
          break;
        } catch (error) {
          if (pathIndex === tryPaths.length - 1 || ![400, 404].includes(error.status)) {
            throw error;
          }
          results.length = 0;
          startCursor = undefined;
          pathIndex += 1;
        }
      }

      return results.filter((page) => {
        const status = getSelectName(page, "Status");
        return status !== "Hidden" && status !== "Archived";
      });
    },

    async retrievePage(pageId) {
      return request(`/v1/pages/${normalizeId(pageId)}`);
    },

    async retrieveBlocks(blockId, depth = 0) {
      const blocks = [];
      let startCursor;

      do {
        const query = startCursor ? `?start_cursor=${encodeURIComponent(startCursor)}` : "";
        const data = await request(`/v1/blocks/${normalizeId(blockId)}/children${query}`);
        blocks.push(...(data.results || []));
        startCursor = data.has_more ? data.next_cursor : undefined;
      } while (startCursor);

      if (depth >= 3) return blocks;

      const expandedBlocks = [];
      for (const block of blocks) {
        if (block.has_children) {
          const children = await this.retrieveBlocks(block.id, depth + 1).catch(() => []);
          expandedBlocks.push({ ...block, children });
        } else {
          expandedBlocks.push(block);
        }
      }

      return expandedBlocks;
    },
  };
}

function createTagResolver(client) {
  const cache = new Map();

  return async function resolveTags(page, propertyName = "Tags") {
    const ids = getRelationIds(page, propertyName);
    const tags = await Promise.all(ids.map(async (id) => {
      if (!cache.has(id)) {
        cache.set(id, client.retrievePage(id).then((tagPage) => getFirstTitle(tagPage)).catch(() => ""));
      }
      return cache.get(id);
    }));

    return tags.filter(Boolean);
  };
}

async function mapArticle(page, client, tagResolver) {
  const title = getTitle(page, "Title");
  if (!title) return null;

  const date = getDateStart(page, "PublishedAt") || getDateStart(page, "SortDate") || "";
  const [tags, blocks] = await Promise.all([
    tagResolver(page),
    client.retrieveBlocks(page.id).catch(() => []),
  ]);

  return {
    id: getRichText(page, "Slug") || slugify(title),
    title,
    date,
    updatedAt: getDateStart(page, "UpdatedAt") || date,
    category: getSelectName(page, "Folder") || "随笔",
    summary: getRichText(page, "Summary"),
    tags,
    content: blocksToArticleContent(blocks),
  };
}

async function mapMoment(page, tagResolver) {
  const title = getTitle(page, "Title");
  const publishedAt = getDateStart(page, "PublishedAt") || getDateStart(page, "SortDate");
  const dateTime = splitDateTime(publishedAt);
  if (!title || !dateTime.date) return null;

  await tagResolver(page);

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

async function mapMedia(page, tagResolver) {
  const title = getTitle(page, "Title");
  if (!title) return null;

  await tagResolver(page);

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

function blocksToArticleContent(blocks) {
  const content = [];

  blocks.forEach((block) => {
    if (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3") {
      content.push({
        type: "heading",
        text: getBlockPlainText(block[block.type]),
        html: getBlockRichTextHtml(block[block.type]),
        level: Number(block.type.slice(-1)),
      });
      return;
    }

    if (block.type === "paragraph") {
      const text = getBlockPlainText(block.paragraph);
      if (text) content.push({ type: "paragraph", text, html: getBlockRichTextHtml(block.paragraph) });
      return;
    }

    if (block.type === "quote") {
      const text = getBlockPlainText(block.quote);
      if (text) content.push({ type: "quote", text, html: getBlockRichTextHtml(block.quote) });
      return;
    }

    if (block.type === "code") {
      const text = getBlockPlainText(block.code, { trim: false });
      if (text) {
        content.push({
          type: "code",
          text,
          language: block.code.language || "",
        });
      }
      return;
    }

    if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
      const text = getBlockPlainText(block[block.type]);
      const html = getBlockRichTextHtml(block[block.type]);
      const ordered = block.type === "numbered_list_item";
      const last = content[content.length - 1];
      if (last?.type === "list" && last.ordered === ordered) {
        last.items.push({ text, html });
      } else if (text) {
        content.push({ type: "list", ordered, items: [{ text, html }] });
      }
      return;
    }

    if (block.type === "to_do") {
      const text = getBlockPlainText(block.to_do);
      if (text) content.push({ type: "todo", text, html: getBlockRichTextHtml(block.to_do), checked: Boolean(block.to_do.checked) });
      return;
    }

    if (block.type === "callout") {
      const text = getBlockPlainText(block.callout);
      if (text) content.push({ type: "callout", text, html: getBlockRichTextHtml(block.callout), icon: getNotionIconText(block.callout.icon) });
      return;
    }

    if (block.type === "divider") {
      content.push({ type: "divider" });
      return;
    }

    if (block.type === "image") {
      const src = getBlockFileUrl(block.image);
      if (src) content.push({ type: "image", src, alt: getBlockCaption(block.image) || "文章图片", caption: getBlockCaption(block.image) });
      return;
    }

    if (["bookmark", "embed", "link_preview", "video", "pdf", "file", "audio"].includes(block.type)) {
      const value = block[block.type];
      const url = getBlockFileUrl(value) || value?.url || "";
      const caption = getBlockCaption(value);
      if (url) content.push({ type: "link", url, text: caption || url, kind: block.type });
      return;
    }

    if (block.type === "equation") {
      const expression = block.equation?.expression || "";
      if (expression) content.push({ type: "code", text: expression, language: "math" });
      return;
    }

    if (block.type === "table_row") {
      const text = (block.table_row?.cells || [])
        .map((cell) => cell.map((item) => item.plain_text || "").join("").trim())
        .filter(Boolean)
        .join(" ｜ ");
      if (text) content.push({ type: "paragraph", text });
      return;
    }

    if (block.type === "toggle") {
      const text = getBlockPlainText(block.toggle);
      if (text) {
        content.push({
          type: "toggle",
          text,
          html: getBlockRichTextHtml(block.toggle),
          children: blocksToArticleContent(block.children || []),
        });
      }
      return;
    }

    if (["table_of_contents", "breadcrumb", "child_page", "child_database", "synced_block", "template"].includes(block.type)) {
      const text = getBlockPlainText(block[block.type]) || getPlainBlockTitle(block);
      if (text) content.push({ type: "paragraph", text });
      return;
    }

    const fallbackText = getBlockPlainText(block[block.type]);
    if (fallbackText) {
      content.push({ type: "paragraph", text: fallbackText });
    }
  });

  return content.length
    ? content
    : [{ type: "paragraph", text: "这篇文章还没有正文。" }];
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

function getFirstTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find((property) => property.type === "title");
  return (titleProperty?.title || []).map((item) => item.plain_text || "").join("").trim();
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

function getRelationIds(page, name) {
  return (getProperty(page, name)?.relation || []).map((item) => item.id).filter(Boolean);
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

function getBlockPlainText(value, options = {}) {
  const text = (value?.rich_text || []).map((item) => item.plain_text || "").join("");
  return options.trim === false ? text.replace(/\n+$/, "") : text.trim();
}

function getBlockRichTextHtml(value) {
  return (value?.rich_text || [])
    .map((item) => renderRichTextItem(item))
    .join("");
}

function renderRichTextItem(item) {
  let html = escapeHtml(item.plain_text || "");
  const annotations = item.annotations || {};

  if (annotations.code) html = `<code>${html}</code>`;
  if (annotations.bold) html = `<strong>${html}</strong>`;
  if (annotations.italic) html = `<em>${html}</em>`;
  if (annotations.strikethrough) html = `<s>${html}</s>`;
  if (annotations.underline) html = `<u>${html}</u>`;

  const href = safeUrl(item.href || item.text?.link?.url || "");
  if (href) {
    html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
  }

  return html;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (url.startsWith("#") || url.startsWith("/")) return url;
  return "";
}

function getBlockCaption(value) {
  return (value?.caption || []).map((item) => item.plain_text || "").join("").trim();
}

function getBlockFileUrl(value) {
  if (!value) return "";
  if (value.type === "external") return value.external?.url || "";
  if (value.type === "file") return value.file?.url || "";
  return value.url || "";
}

function getNotionIconText(icon) {
  if (!icon) return "";
  if (icon.type === "emoji") return icon.emoji || "";
  return "";
}

function getPlainBlockTitle(block) {
  if (block.type === "child_page") return block.child_page?.title || "";
  if (block.type === "child_database") return block.child_database?.title || "";
  return "";
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

function normalizeId(value) {
  return String(value || "").replace(/^collection:\/\//, "").trim();
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

module.exports = {
  fetchNotionContent,
  getNotionConfig,
};
