import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CONVERTER_VERSION = "2";
export const MANIFEST_SCHEMA_VERSION = 1;
export const ROOT_KEY = "README.zh-CN.md";
export const SYSTEM_TITLE = "系统（同步管理）";
export const STATE_TITLE = "同步状态（系统）";
export const ARCHIVE_TITLE = "归档（系统）";
export const STATE_MARKER = "AWESOME_AGENT_ARCHITECTURE_SYNC_STATE";

const GITHUB_REPOSITORY_URL = "https://github.com/hardness1020/awesome-agent-architecture";
const DEFAULT_WIKI_BASE_URL = "https://feishu.cn/wiki";
const REMOTE_ASSET_CACHE_DIR = ".feishu-sync-assets";
const REMOTE_ASSET_MARKER = ".managed-by-agent-harness-learning";
const GITHUB_ATTACHMENT_PATTERN = /https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+/g;
const MAX_REMOTE_ASSET_BYTES = 25 * 1024 * 1024;

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function detectImageExtension(bytes) {
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "gif";
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  throw new Error("trusted remote attachment is not a supported image");
}

function remoteAssetCachePath(sourceDir) {
  return path.join(sourceDir, REMOTE_ASSET_CACHE_DIR);
}

export function cleanupRemoteAssetCache(sourceDir) {
  const cacheDir = remoteAssetCachePath(sourceDir);
  const markerPath = path.join(cacheDir, REMOTE_ASSET_MARKER);
  if (fs.existsSync(markerPath)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function downloadRemoteAssetWithCurl(url) {
  try {
    return execFileSync("curl", [
      "-fsSL",
      "--max-time", "60",
      "--max-filesize", String(MAX_REMOTE_ASSET_BYTES),
      url
    ], {
      encoding: "buffer",
      maxBuffer: MAX_REMOTE_ASSET_BYTES + 1024
    });
  } catch {
    throw new Error("failed to download trusted remote attachment with fetch and curl");
  }
}

async function downloadRemoteAsset(url, fetchImpl, fallbackImpl) {
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      headers: { "User-Agent": "Agent-Harness-Learning-Feishu-Sync" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_REMOTE_ASSET_BYTES) {
      throw new Error("declared remote attachment is too large");
    }
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return Buffer.from(await fallbackImpl(url));
  }
}

export async function materializeRemoteAssets(
  pages,
  sourceDir,
  fetchImpl = globalThis.fetch,
  fallbackImpl = downloadRemoteAssetWithCurl
) {
  const urls = [...new Set(pages.flatMap((page) => page.remoteAssets))].sort();
  const assets = new Map();
  if (urls.length === 0) {
    return assets;
  }

  const cacheDir = remoteAssetCachePath(sourceDir);
  if (fs.existsSync(cacheDir) && !fs.existsSync(path.join(cacheDir, REMOTE_ASSET_MARKER))) {
    throw new Error(`${REMOTE_ASSET_CACHE_DIR} exists without the managed cache marker`);
  }
  cleanupRemoteAssetCache(sourceDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, REMOTE_ASSET_MARKER), "managed transient assets\n", { mode: 0o600 });

  const hasConfiguredProxy = Boolean(
    process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
  );
  const preferFallback = fetchImpl === globalThis.fetch && hasConfiguredProxy;
  for (const url of urls) {
    const bytes = preferFallback
      ? Buffer.from(await fallbackImpl(url))
      : await downloadRemoteAsset(url, fetchImpl, fallbackImpl);
    if (bytes.length === 0 || bytes.length > MAX_REMOTE_ASSET_BYTES) {
      throw new Error(`trusted remote attachment has invalid size: ${bytes.length}`);
    }
    const extension = detectImageExtension(bytes);
    const assetId = url.slice(url.lastIndexOf("/") + 1);
    const relativePath = `${REMOTE_ASSET_CACHE_DIR}/${assetId}.${extension}`;
    fs.writeFileSync(path.join(sourceDir, relativePath), bytes, { mode: 0o600 });
    assets.set(url, {
      relativePath,
      hash: sha256(bytes),
      extension,
      size: bytes.length
    });
  }
  return assets;
}

function stripInlineMarkdown(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveTitle(content, sourcePath) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (title) {
      return stripInlineMarkdown(title[1]);
    }
  }

  const htmlHeading = content.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (htmlHeading) {
    return stripInlineMarkdown(htmlHeading[1]);
  }

  const markdownHeading = content.match(/^#\s+(.+)$/m);
  if (markdownHeading) {
    return stripInlineMarkdown(markdownHeading[1]);
  }

  const filename = path.basename(sourcePath).replace(/\.md$/i, "");
  return filename.replace(/[._-]+/g, " ").trim();
}

function protectCodeFences(content) {
  const fences = [];
  const protectedContent = content.replace(/```[\s\S]*?```/g, (block) => {
    const placeholder = `\u0000FENCE_${fences.length}\u0000`;
    fences.push(block);
    return placeholder;
  });
  return { protectedContent, fences };
}

function restoreCodeFences(content, fences) {
  return content.replace(/\u0000FENCE_(\d+)\u0000/g, (_, index) => fences[Number(index)]);
}

function validateSupportedMarkdown(content, sourcePath) {
  const { protectedContent } = protectCodeFences(content);
  const unsupported = [];
  if (/```mermaid/i.test(content)) {
    unsupported.push("Mermaid");
  }
  if (/\$\$|(^|[^\\])\$[^\n$]+\$/m.test(protectedContent)) {
    unsupported.push("LaTeX formula");
  }
  if (/^\s*:::/m.test(protectedContent)) {
    unsupported.push("container directive");
  }
  if (unsupported.length > 0) {
    throw new Error(`${sourcePath}: unsupported syntax: ${unsupported.join(", ")}`);
  }
}

function extractMarkdownImages(content, sourcePath, sourceDir) {
  const assets = [];
  const sourceDirectory = path.posix.dirname(sourcePath);
  const imagePattern = /!\[[^\]]*\]\((?:<)?([^)>\s]+)(?:>)?\)/g;
  for (const match of content.matchAll(imagePattern)) {
    const target = match[1];
    if (/^(?:https?:|data:|@)/i.test(target)) {
      continue;
    }
    const resolved = normalizePath(path.posix.normalize(path.posix.join(sourceDirectory, target)));
    const absolutePath = path.join(sourceDir, resolved);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`${sourcePath}: missing image ${target}`);
    }
    assets.push(resolved);
  }
  return assets;
}

function extractManagedRemoteImages(content) {
  return [...new Set(content.match(GITHUB_ATTACHMENT_PATTERN) ?? [])].sort();
}

function convertHtml(content) {
  return content
    .replace(
      /<a\s+href="([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"\s+alt="([^"]*)"[^>]*>\s*<\/a>/gi,
      "[$3]($1)"
    )
    .replace(
      /<img\s+src="(https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+)"\s+alt="([^"]*)"[^>]*>/gi,
      "![$2]($1)"
    )
    .replace(/<img\s+src="([^"]+)"\s+alt="([^"]*)"[^>]*>/gi, "[图片：$2]($1)")
    .replace(/<img\s+src="([^"]+)"[^>]*>/gi, "[外部图片]($1)")
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p\b[^>]*>/gi, "")
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "");
}

function removeDuplicateTitle(content, title) {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (headingIndex >= 0 && stripInlineMarkdown(lines[headingIndex].replace(/^#\s+/, "")) === title) {
    lines.splice(headingIndex, 1);
  }
  return lines.join("\n").replace(/^\s+/, "");
}

function splitTarget(target) {
  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const endIndex = indexes.length > 0 ? Math.min(...indexes) : target.length;
  return {
    pathname: target.slice(0, endIndex),
    suffix: target.slice(endIndex)
  };
}

function resolveRepositoryPath(sourcePath, target) {
  const decodedTarget = decodeURIComponent(target);
  return normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decodedTarget)));
}

function rewriteLinks(content, page, nodeMap, warnings, wikiBaseUrl) {
  return content.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (full, label, rawTarget) => {
    const target = rawTarget.trim().replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/i.test(target)) {
      return full;
    }

    const { pathname, suffix } = splitTarget(target);
    const resolved = resolveRepositoryPath(page.sourcePath, pathname);
    const managedTarget = nodeMap.get(resolved);
    if (managedTarget) {
      if (suffix.startsWith("#")) {
        warnings.push(`${page.sourcePath}: heading anchor degraded for ${target}`);
      }
      return `[${label}](${wikiBaseUrl}/${managedTarget.nodeToken})`;
    }

    const sourceUrl = `${GITHUB_REPOSITORY_URL}/blob/${page.commit}/${encodeURI(resolved)}${suffix}`;
    return `[${label}](${sourceUrl})`;
  });
}

function rewriteImages(content, page, remoteAssets) {
  return content.replace(/!\[([^\]]*)\]\((?:<)?([^)>\s]+)(?:>)?\)/g, (full, alt, target) => {
    if (/^https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+$/i.test(target)) {
      const asset = remoteAssets.get(target);
      if (!asset) {
        throw new Error(`${page.sourcePath}: trusted remote image was not materialized`);
      }
      return `![${alt}](@./${asset.relativePath})`;
    }
    if (/^https?:/i.test(target)) {
      return `[图片：${alt || "外部图片"}](${target})`;
    }
    if (/^(?:data:|@)/i.test(target)) {
      return full;
    }
    const resolved = resolveRepositoryPath(page.sourcePath, target);
    return `![${alt}](@./${resolved})`;
  });
}

export function transformPage(
  page,
  nodeMap,
  sourceDir,
  wikiBaseUrl = DEFAULT_WIKI_BASE_URL,
  remoteAssets = new Map()
) {
  validateSupportedMarkdown(page.rawContent, page.sourcePath);
  const warnings = [];
  const { protectedContent, fences } = protectCodeFences(page.rawContent.replace(/\r\n/g, "\n"));
  let content = convertHtml(protectedContent);
  content = removeDuplicateTitle(content, page.title);
  content = rewriteLinks(content, page, nodeMap, warnings, wikiBaseUrl.replace(/\/$/, ""));
  content = rewriteImages(content, page, remoteAssets);
  content = restoreCodeFences(content, fences).trim();

  const body = `${content}\n`;
  const assetEntries = page.assets
    .map((assetPath) => {
      const bytes = fs.readFileSync(path.join(sourceDir, assetPath));
      return `${assetPath}\u0000${sha256(bytes)}`;
    })
    .sort();
  const remoteAssetEntries = page.remoteAssets
    .map((url) => {
      const asset = remoteAssets.get(url);
      if (!asset) {
        throw new Error(`${page.sourcePath}: trusted remote image was not materialized`);
      }
      return `${url}\u0000${asset.hash}`;
    })
    .sort();
  const renderHash = sha256([
    CONVERTER_VERSION,
    body,
    page.title,
    page.parentKey ?? "",
    ...assetEntries,
    ...remoteAssetEntries
  ].join("\u0000"));
  return { body, renderHash, warnings };
}

function collectMarkdownFiles(sourceDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name === "README.zh-CN.md") {
        files.push(normalizePath(path.relative(sourceDir, absolutePath)));
      }
    }
  };
  visit(sourceDir);
  return files;
}

export function discoverPages(sourceDir, commit) {
  const rootPath = path.join(sourceDir, ROOT_KEY);
  if (!fs.existsSync(rootPath)) {
    throw new Error(`missing source root: ${rootPath}`);
  }
  const rootContent = fs.readFileSync(rootPath, "utf8");
  const ordered = [ROOT_KEY];
  const orderPattern = /\[[^\]]+\]\((sections\/[^)]+\/README\.zh-CN\.md)\)/g;
  for (const match of rootContent.matchAll(orderPattern)) {
    if (!ordered.includes(match[1])) {
      ordered.push(match[1]);
    }
  }
  const remaining = collectMarkdownFiles(sourceDir)
    .filter((sourcePath) => !ordered.includes(sourcePath))
    .sort();
  ordered.push(...remaining);

  const pages = ordered.map((sourcePath, order) => {
    const rawContent = fs.readFileSync(path.join(sourceDir, sourcePath), "utf8");
    validateSupportedMarkdown(rawContent, sourcePath);
    return {
      stableKey: sourcePath,
      sourcePath,
      parentKey: sourcePath === ROOT_KEY ? null : ROOT_KEY,
      title: deriveTitle(rawContent, sourcePath),
      rawContent,
      assets: extractMarkdownImages(rawContent, sourcePath, sourceDir),
      remoteAssets: extractManagedRemoteImages(rawContent),
      order,
      commit
    };
  });

  const uniqueKeys = new Set(pages.map((page) => page.stableKey));
  if (uniqueKeys.size !== pages.length) {
    throw new Error("duplicate stable key in content model");
  }
  return pages;
}

export function createManifest(spaceId, rootNode, commit) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    converterVersion: CONVERTER_VERSION,
    status: "idle",
    spaceId,
    rootNodeToken: rootNode.nodeToken,
    targetCommit: "",
    lastSyncedCommit: "",
    topologyHash: "",
    pendingCreateKey: "",
    pages: {
      [ROOT_KEY]: {
        sourcePath: ROOT_KEY,
        parentKey: null,
        title: rootNode.title,
        nodeToken: rootNode.nodeToken,
        objToken: rootNode.objToken,
        renderHash: "",
        revisionId: 0
      }
    },
    helpers: {},
    archives: [],
    lastReport: {
      sourceCommit: commit,
      created: 0,
      updated: 0,
      moved: 0,
      renamed: 0,
      archived: 0,
      skipped: 0,
      warnings: []
    }
  };
}

export function validateManifest(manifest, expected) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("missing or unsupported manifest schema");
  }
  if (manifest.spaceId !== expected.spaceId || manifest.rootNodeToken !== expected.rootNodeToken) {
    throw new Error("manifest target does not match the configured space/root");
  }
  const tokens = new Set();
  for (const [key, page] of Object.entries(manifest.pages ?? {})) {
    if (!page.nodeToken || !page.objToken) {
      throw new Error(`manifest page ${key} is missing tokens`);
    }
    if (tokens.has(page.nodeToken)) {
      throw new Error(`duplicate node token ownership: ${page.nodeToken}`);
    }
    tokens.add(page.nodeToken);
  }
  return manifest;
}

export function migrateRenames(manifest, renames) {
  for (const { from, to } of renames) {
    if (!manifest.pages[from] || manifest.pages[to]) {
      continue;
    }
    manifest.pages[to] = {
      ...manifest.pages[from],
      sourcePath: to
    };
    delete manifest.pages[from];
  }
  return manifest;
}

export function topologyHash(pages) {
  return sha256(pages.map((page) => [page.stableKey, page.parentKey ?? "", page.title, page.order].join("\u0000")).join("\n"));
}

export function buildActionPlan(pages, manifest, mode = "incremental") {
  const desiredKeys = new Set(pages.map((page) => page.stableKey));
  const actions = [];
  for (const page of pages) {
    const current = manifest.pages[page.stableKey];
    if (!current) {
      actions.push({ action: "create", key: page.stableKey, title: page.title });
      continue;
    }
    if (current.title !== page.title) {
      actions.push({ action: "rename", key: page.stableKey, from: current.title, to: page.title });
    }
    if (current.parentKey !== page.parentKey) {
      actions.push({ action: "move", key: page.stableKey, from: current.parentKey, to: page.parentKey });
    }
    if (mode === "full" || !current.renderHash) {
      actions.push({ action: "update", key: page.stableKey, reason: mode === "full" ? "full" : "missing_hash" });
    }
  }
  for (const [key, current] of Object.entries(manifest.pages)) {
    if (key !== ROOT_KEY && !desiredKeys.has(key)) {
      actions.push({ action: "archive", key, title: current.title });
    }
  }
  return actions;
}

export function serializeManifest(manifest) {
  return [
    `# ${STATE_TITLE}`,
    "",
    "> 此页面由同步程序维护，请勿编辑。",
    "",
    `> 管理标记：${STATE_MARKER}`,
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    ""
  ].join("\n");
}

export function parseManifest(content) {
  if (!content.includes(STATE_MARKER)) {
    throw new Error("state page is missing the ownership marker");
  }
  const match = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) {
    throw new Error("state page is missing its JSON manifest");
  }
  return JSON.parse(match[1]);
}

export function summarizeModel(pages) {
  return {
    sourcePages: pages.length,
    sectionPages: pages.filter((page) => page.parentKey === ROOT_KEY).length,
    syntheticNodes: 0,
    localAssets: pages.reduce((count, page) => count + page.assets.length, 0),
    mirroredRemoteAssets: new Set(pages.flatMap((page) => page.remoteAssets)).size,
    titles: pages.map((page) => page.title)
  };
}

export function hasUnresolvedManagedLink(content) {
  return /\]\((?!https?:\/\/|mailto:|#)[^)]*README\.zh-CN\.md(?:#[^)]*)?\)/.test(content);
}
