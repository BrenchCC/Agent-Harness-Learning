import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONVERTER_VERSION = "1";
export const MANIFEST_SCHEMA_VERSION = 1;
export const ROOT_KEY = "README.zh-CN.md";
export const SYSTEM_TITLE = "系统（同步管理）";
export const STATE_TITLE = "同步状态（系统）";
export const ARCHIVE_TITLE = "归档（系统）";
export const STATE_MARKER = "AWESOME_AGENT_ARCHITECTURE_SYNC_STATE";

const GITHUB_REPOSITORY_URL = "https://github.com/hardness1020/awesome-agent-architecture";
const DEFAULT_WIKI_BASE_URL = "https://feishu.cn/wiki";

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function convertHtml(content) {
  return content
    .replace(
      /<a\s+href="([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"\s+alt="([^"]*)"[^>]*>\s*<\/a>/gi,
      "[$3]($1)"
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

function rewriteImages(content, page) {
  return content.replace(/!\[([^\]]*)\]\((?:<)?([^)>\s]+)(?:>)?\)/g, (full, alt, target) => {
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

export function transformPage(page, nodeMap, sourceDir, wikiBaseUrl = DEFAULT_WIKI_BASE_URL) {
  validateSupportedMarkdown(page.rawContent, page.sourcePath);
  const warnings = [];
  const { protectedContent, fences } = protectCodeFences(page.rawContent.replace(/\r\n/g, "\n"));
  let content = convertHtml(protectedContent);
  content = removeDuplicateTitle(content, page.title);
  content = rewriteLinks(content, page, nodeMap, warnings, wikiBaseUrl.replace(/\/$/, ""));
  content = rewriteImages(content, page);
  content = restoreCodeFences(content, fences).trim();

  const footer = [
    "---",
    "> 本页由 GitHub 仓库单向同步，请勿直接编辑；手工修改会在下次同步时被覆盖。",
    `> 来源：[${page.sourcePath}](${GITHUB_REPOSITORY_URL}/blob/${page.commit}/${encodeURI(page.sourcePath)}) · 上游提交：\`${page.commit}\``
  ].join("\n");
  const body = `${content}\n\n${footer}\n`;
  const assetEntries = page.assets
    .map((assetPath) => {
      const bytes = fs.readFileSync(path.join(sourceDir, assetPath));
      return `${assetPath}\u0000${sha256(bytes)}`;
    })
    .sort();
  const renderHash = sha256([
    CONVERTER_VERSION,
    body,
    page.title,
    page.parentKey ?? "",
    ...assetEntries
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
    titles: pages.map((page) => page.title)
  };
}

export function hasUnresolvedManagedLink(content) {
  return /\]\((?!https?:\/\/|mailto:|#)[^)]*README\.zh-CN\.md(?:#[^)]*)?\)/.test(content);
}
