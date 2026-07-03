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

// Signatures of an anti-bot wall (Cloudflare, DataDome, etc.) serving a challenge
// instead of the real page. Conservative: we require a SHORT body plus a marker so
// a normal article that merely mentions "cloudflare" in its text isn't flagged.
const BLOCK_MARKERS = [
  "just a moment", "checking your browser", "cf-browser-verification", "__cf_chl",
  "cf_chl_opt", "cf-challenge", "attention required", "ddos protection by",
  "please verify you are a human", "are you a human", "verify you are human",
  "datadome", "px-captcha", "perimeterx", "captcha-delivery", "/cdn-cgi/challenge",
];

function detectAntiBotBlock(status, headers, bodySample) {
  if (status === 403 || status === 429 || status === 503) return "http-" + status;
  const body = (bodySample || "").toLowerCase();
  if (body.length >= 6000) return null; // real pages are big; challenge stubs are small
  const server = (headers.get("server") || "").toLowerCase();
  if (
    body.includes("__cf_chl") ||
    body.includes("cf-browser-verification") ||
    body.includes("just a moment") ||
    (server.includes("cloudflare") && body.includes("turnstile"))
  ) {
    return "cloudflare-challenge";
  }
  for (const m of BLOCK_MARKERS) if (body.includes(m)) return "anti-bot";
  // "enable javascript" only counts on a near-empty body (real SPAs are large).
  if (body.length < 1500 && body.includes("enable javascript")) return "js-required";
  return null;
}

export async function webFetch(url, maxLength = 0) {
  let resp;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AzulaBot/1.0)" },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });
  } catch (err) {
    return { success: false, error: err.message };
  }

  const contentType = (resp.headers.get("content-type") || "").split(";")[0].trim();
  let text = "";
  try { text = await resp.text(); } catch {}

  // Anti-bot block? Covers both HTTP errors AND a 200 that is really a challenge
  // page. On a hit we tell the model to retry via the Camoufox stealth browser.
  const block = detectAntiBotBlock(resp.status, resp.headers, text.slice(0, 6000));
  if (block) {
    return {
      success: false,
      blocked: true,
      blockType: block,
      url,
      error:
        "This page is protected by anti-bot (" + block + ") and could not be fetched normally. " +
        "Retry this EXACT url with the camoufox__fetch_url tool — it renders the page in a stealth " +
        "browser that bypasses bot detection. (If that tool isn't available, install the Camoufox " +
        "plugin in the config UI, then retry.)",
    };
  }

  if (!resp.ok) {
    return { success: false, error: `HTTP ${resp.status} ${resp.statusText}` };
  }

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
}
