const NOTION_VERSION = "2022-06-28";

function getNotionConfig(env = process.env) {
  return {
    token: env.NOTION_TOKEN,
    articlesSourceId: env.NOTION_ARTICLES_SOURCE_ID,
    momentsSourceId: env.NOTION_MOMENTS_SOURCE_ID,
    mediaSourceId: env.NOTION_MEDIA_SOURCE_ID,
    siteConfigSourceId: env.NOTION_SITE_CONFIG_SOURCE_ID,
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
  const [articlePages, momentPages, mediaPages, siteConfigPages] = await Promise.all([
    client.querySource(config.articlesSourceId),
    client.querySource(config.momentsSourceId),
    client.querySource(config.mediaSourceId),
    queryOptionalSource(client, config.siteConfigSourceId),
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
  } catch {
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

    async retrieveBlocks(blockId) {
      const blocks = [];
      let startCursor;

      do {
        const query = startCursor ? `?start_cursor=${encodeURIComponent(startCursor)}` : "";
        const data = await request(`/v1/blocks/${normalizeId(blockId)}/children${query}`);
        blocks.push(...(data.results || []));
        startCursor = data.has_more ? data.next_cursor : undefined;
      } while (startCursor);

      return blocks;
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

  return {
    id: title,
    date: dateTime.date,
    time: dateTime.time,
    text: getRichText(page, "Content"),
    location: getRichText(page, "Location"),
    weather: getSelectName(page, "Weather") || getRichText(page, "Weather"),
    photos: getFiles(page, "Photos").map((file) => ({
      src: file.url,
      alt: file.name || title,
      shape: "wide",
    })),
    notes: [],
  };
}

async function mapMedia(page, tagResolver) {
  const title = getTitle(page, "Title");
  if (!title) return null;

  await tagResolver(page);

  const finishedAt = getDateStart(page, "FinishedAt") || getDateStart(page, "SortDate") || "";
  const cover = getFiles(page, "Cover")[0];

  return {
    month: finishedAt ? finishedAt.slice(0, 7).replace("-", ".") : "未归档",
    item: {
      date: finishedAt,
      type: getSelectName(page, "Type") || "综合",
      title,
      creator: getRichText(page, "Creator"),
      review: getRichText(page, "Review"),
      cover: "a",
      url: getUrl(page, "SourceURL") || "#",
      poster: cover?.url || "",
      rating: getNumber(page, "Rating"),
    },
  };
}

function blocksToArticleContent(blocks) {
  const content = [];

  blocks.forEach((block) => {
    if (block.type === "heading_1" || block.type === "heading_2" || block.type === "heading_3") {
      content.push({ type: "heading", text: getBlockPlainText(block[block.type]) });
      return;
    }

    if (block.type === "paragraph") {
      const text = getBlockPlainText(block.paragraph);
      if (text) content.push({ type: "paragraph", text });
      return;
    }

    if (block.type === "quote") {
      const text = getBlockPlainText(block.quote);
      if (text) content.push({ type: "quote", text });
      return;
    }

    if (block.type === "bulleted_list_item" || block.type === "numbered_list_item") {
      const text = getBlockPlainText(block[block.type]);
      const last = content[content.length - 1];
      if (last?.type === "list") {
        last.items.push(text);
      } else if (text) {
        content.push({ type: "list", items: [text] });
      }
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

function getFirstTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find((property) => property.type === "title");
  return (titleProperty?.title || []).map((item) => item.plain_text || "").join("").trim();
}

function getRichText(page, name) {
  const property = getProperty(page, name);
  return (property?.rich_text || []).map((item) => item.plain_text || "").join("").trim();
}

function getSelectName(page, name) {
  return getProperty(page, name)?.select?.name || "";
}

function getNumber(page, name) {
  return getProperty(page, name)?.number ?? null;
}

function getCheckbox(page, name) {
  const property = getProperty(page, name);
  if (!property || property.checkbox == null) return null;
  return Boolean(property.checkbox);
}

function getUrl(page, name) {
  return getProperty(page, name)?.url || "";
}

function getDateStart(page, name) {
  return getProperty(page, name)?.date?.start || "";
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

function getBlockPlainText(value) {
  return (value?.rich_text || []).map((item) => item.plain_text || "").join("").trim();
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
