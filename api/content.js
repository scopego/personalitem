const { fetchNotionContent, getNotionConfig } = require("../lib/notion-content");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const content = await fetchNotionContent(getNotionConfig(process.env));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(content);
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      error: "Failed to load Notion content",
      message: error.message,
    });
  }
};
