import config from "../config/index.js";

export async function webSearch(query, count = 5) {
  const BRAVE_API_KEY = config.braveApiKey;
  if (!BRAVE_API_KEY) {
    return { success: false, error: "web_search is unavailable: BRAVE_API_KEY is not configured" };
  }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count || 5, 20)}`;
  try {
    const resp = await fetch(url, {
      headers: {
        "X-Subscription-Token": BRAVE_API_KEY,
        "Accept": "application/json",
      },
    });
    if (!resp.ok) {
      return { success: false, error: `Brave API returned ${resp.status}: ${resp.statusText}` };
    }
    const data = await resp.json();
    const results = (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));
    return { success: true, query, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function webFetch(url, maxLength = 0) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AzulaBot/1.0)" },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });
    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const contentType = (resp.headers.get("content-type") || "").split(";")[0].trim();
    const text = await resp.text();

    if (contentType.includes("json")) {
      return { success: true, content_type: contentType, content: text };
    }

    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    return { success: true, content_type: contentType, content: cleaned };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
