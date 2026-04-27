import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import process from "node:process";

const dryRun = process.argv.includes("--dry-run");
const now = new Date().toISOString();

const statePath = ".state/state.json";
const sourcesPath = "sources.json";
const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 15000);

async function main() {
  const [sources, state] = await Promise.all([readJson(sourcesPath, []), readJson(statePath, {})]);
  const nextState = { ...state };
  const events = [];
  const errors = [];

  for (const source of sources) {
    try {
      const snapshot = await fetchSnapshot(source);
      const previous = state[source.id];

      if (!previous || !previous.fingerprint) {
        nextState[source.id] = { ...snapshot, firstSeenAt: now, lastCheckedAt: now };
        continue;
      }

      if (previous.fingerprint !== snapshot.fingerprint) {
        const event = buildEvent(source, previous, snapshot);
        events.push(event);
        nextState[source.id] = { ...snapshot, firstSeenAt: previous.firstSeenAt, lastChangedAt: now, lastCheckedAt: now };
      } else {
        nextState[source.id] = { ...previous, lastCheckedAt: now };
      }
    } catch (error) {
      errors.push({ source: source.id, message: error.message });
      nextState[source.id] = { ...(state[source.id] || {}), lastCheckedAt: now, lastError: error.message };
    }
  }

  if (!dryRun) {
    await mkdir(".state", { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    await writeFile(".state/last-events.json", `${JSON.stringify({ checkedAt: now, events, errors }, null, 2)}\n`);
  }

  if (events.length) {
    const message = renderNotification(events, errors);
    console.log(message);
    if (!dryRun) {
      await sendSlack(message);
      await sendDiscord(message);
    }
  } else {
    console.log(`No new updates. Checked ${sources.length} sources. Errors: ${errors.length}`);
  }

  if (errors.length) {
    console.log("Source errors:");
    for (const error of errors) console.log(`- ${error.source}: ${error.message}`);
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fetchSnapshot(source) {
  if (source.type === "github_releases") return fetchGitHubRelease(source);
  if (source.type === "github_tags") return fetchGitHubTag(source);
  if (source.type === "npm") return fetchNpmPackage(source);
  if (source.type === "webpage") return fetchWebpage(source);
  throw new Error(`Unsupported source type: ${source.type}`);
}

async function fetchGitHubRelease(source) {
  const releases = await fetchJson(`https://api.github.com/repos/${source.repo}/releases?per_page=1`, {
    Accept: "application/vnd.github+json",
    "User-Agent": "ai-update-newsletter-watch"
  });
  const latest = releases[0];
  if (!latest) throw new Error(`No releases found for ${source.repo}`);

  return {
    fingerprint: String(latest.id || latest.tag_name),
    title: `${source.repo} ${latest.name || latest.tag_name}`,
    version: latest.tag_name,
    url: latest.html_url,
    publishedAt: latest.published_at || latest.created_at,
    summaryText: trimText(latest.body || "")
  };
}

async function fetchGitHubTag(source) {
  const tags = await fetchJson(`https://api.github.com/repos/${source.repo}/tags?per_page=1`, {
    Accept: "application/vnd.github+json",
    "Accept-Language": "en",
    "User-Agent": "ai-update-newsletter-watch"
  });
  const latest = tags[0];
  if (!latest) throw new Error(`No tags found for ${source.repo}`);

  return {
    fingerprint: latest.commit?.sha || latest.name,
    title: `${source.repo} ${latest.name}`,
    version: latest.name,
    url: `https://github.com/${source.repo}/releases/tag/${latest.name}`,
    publishedAt: null,
    summaryText: ""
  };
}

async function fetchNpmPackage(source) {
  const encodedName = source.package.replace("/", "%2f");
  const data = await fetchJson(`https://registry.npmjs.org/${encodedName}`, {
    Accept: "application/json",
    "Accept-Language": "en",
    "User-Agent": "ai-update-newsletter-watch"
  });
  const version = data["dist-tags"]?.latest;
  if (!version) throw new Error(`No latest npm version found for ${source.package}`);
  const meta = data.versions?.[version] || {};

  return {
    fingerprint: version,
    title: `${source.package} ${version}`,
    version,
    url: `https://www.npmjs.com/package/${encodedName}/v/${version}`,
    publishedAt: data.time?.[version],
    summaryText: trimText(meta.description || data.description || "")
  };
}

async function fetchWebpage(source) {
  const text = await fetchText(source.url, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en",
    "User-Agent": "ai-update-newsletter-watch"
  });
  const normalized = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = normalized.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim() || source.name;

  return {
    fingerprint: sha256(normalized),
    title,
    version: null,
    url: source.url,
    publishedAt: null,
    summaryText: trimText(stripHtml(normalized))
  };
}

async function fetchJson(url, headers) {
  return JSON.parse(await fetchText(url, headers));
}

async function fetchText(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildEvent(source, previous, snapshot) {
  return {
    sourceId: source.id,
    sourceName: source.name,
    type: source.type,
    title: snapshot.title,
    version: snapshot.version,
    url: snapshot.url,
    tags: source.tags || [],
    previousVersion: previous.version || null,
    publishedAt: snapshot.publishedAt,
    detectedAt: now,
    summaryText: snapshot.summaryText
  };
}

function renderNotification(events, errors) {
  const lines = [`AI update watch: ${events.length} new update(s) detected`];
  for (const event of events) {
    const version = event.version ? ` (${event.version})` : "";
    const tags = event.tags?.length ? ` [${event.tags.join(", ")}]` : "";
    lines.push(`\n- ${event.sourceName}${version}${tags}`);
    lines.push(`  ${event.title}`);
    lines.push(`  ${event.url}`);
    if (event.previousVersion && event.previousVersion !== event.version) {
      lines.push(`  previous: ${event.previousVersion}`);
    }
  }
  if (errors.length) lines.push(`\n${errors.length} source(s) failed; see workflow logs.`);
  return lines.join("\n");
}

async function sendSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await postJson(url, { text });
}

async function sendDiscord(text) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  await postJson(url, { content: text.slice(0, 1900) });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Notification failed: ${response.status} ${response.statusText}`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function trimText(text, max = 500) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
