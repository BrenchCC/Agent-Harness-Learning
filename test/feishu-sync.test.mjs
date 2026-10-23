import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  ROOT_KEY,
  buildActionPlan,
  cleanupRemoteAssetCache,
  createManifest,
  deriveTitle,
  discoverPages,
  hasUnresolvedManagedLink,
  materializeRemoteAssets,
  migrateRenames,
  parseManifest,
  serializeManifest,
  summarizeModel,
  transformPage,
  validateManifest
} from "../scripts/feishu-sync/core.mjs";
import { WikiSynchronizer } from "../scripts/feishu-sync/sync.mjs";
import { isNoopPartialSuccess } from "../scripts/feishu-sync/lark-client.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(repositoryRoot, "awesome-agent-architecture");
const commit = "0123456789abcdef0123456789abcdef01234567";

test("discovers the complete simplified Chinese content model in source order", () => {
  const pages = discoverPages(sourceDir, commit);
  const model = summarizeModel(pages);
  const sectionPaths = fs.readdirSync(path.join(sourceDir, "sections"))
    .map((section) => `sections/${section}/${ROOT_KEY}`)
    .filter((sourcePath) => fs.existsSync(path.join(sourceDir, sourcePath)));
  assert.deepEqual(new Set(pages.map((page) => page.sourcePath)), new Set([ROOT_KEY, ...sectionPaths]));
  assert.equal(model.sourcePages, sectionPaths.length + 1);
  assert.equal(model.sectionPages, sectionPaths.length);
  assert.equal(pages[0].stableKey, ROOT_KEY);
  assert.equal(pages[1].stableKey, "sections/00-harness-thesis/README.zh-CN.md");
  assert.ok(pages.findIndex((page) => page.stableKey === "sections/23-evaluation/README.zh-CN.md")
    < pages.findIndex((page) => page.stableKey === "sections/21-loop-engineering/README.zh-CN.md"));
  assert.equal(pages.at(-1).stableKey, "sections/22-graph-engineering/README.zh-CN.md");
});

test("CLI check accepts changing page and asset inventories", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-inventory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remoteUrls = ["first-image", "second-image"]
    .map((id) => `https://github.com/user-attachments/assets/${id}`);
  const rootContent = ["# Learn Agent Architecture", "![Root](root.png)",
    ...remoteUrls.map((url) => `![Remote](${url})`)];
  fs.writeFileSync(path.join(directory, ROOT_KEY), rootContent.join("\n\n"));
  fs.writeFileSync(path.join(directory, "root.png"), "root-image");
  const preloadPath = path.join(directory, "fetch.mjs");
  fs.writeFileSync(preloadPath, `
    globalThis.fetch = async () => new Response(Buffer.from("GIF89a-fixture"));
  `);
  const reportPath = path.join(directory, "report.json");
  const env = { ...process.env };
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    delete env[name];
  }
  for (let index = 0; index < 25; index += 1) {
    const sectionDir = path.join(directory, "sections", String(index).padStart(2, "0"));
    fs.mkdirSync(sectionDir, { recursive: true });
    fs.writeFileSync(path.join(sectionDir, ROOT_KEY), `# Section ${index}\n\n![Image](image.png)\n`);
    fs.writeFileSync(path.join(sectionDir, "image.png"), `section-image-${index}`);
    if (index < 23) {
      continue;
    }
    const result = spawnSync(process.execPath, [
      "--import", preloadPath,
      path.join(repositoryRoot, "scripts/feishu-wiki-sync.mjs"), "check",
      "--source-dir", directory, "--commit", commit, "--report", reportPath
    ], { cwd: repositoryRoot, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.model.sourcePages, index + 2);
    assert.equal(report.model.sectionPages, index + 1);
    assert.equal(report.model.localAssets, index + 2);
    assert.equal(report.model.mirroredRemoteAssets, 2);
    assert.equal(fs.existsSync(path.join(directory, ".feishu-sync-assets")), false);
  }
});

test("derives clean titles from HTML, Markdown, and frontmatter", () => {
  assert.equal(deriveTitle("<h1 align=\"center\">**Title**</h1>", "README.md"), "Title");
  assert.equal(deriveTitle("# [Linked title](target.md)", "README.md"), "Linked title");
  assert.equal(deriveTitle("---\ntitle: 'Frontmatter'\n---\n# Other", "README.md"), "Frontmatter");
});

test("transforms links and images deterministically without touching code fences", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-"));
  fs.mkdirSync(path.join(temporaryDir, "assets"));
  fs.writeFileSync(path.join(temporaryDir, "assets", "image.png"), "image-one");
  const page = {
    stableKey: ROOT_KEY,
    sourcePath: ROOT_KEY,
    parentKey: null,
    title: "Root",
    rawContent: "# Root\n\n[Page](sections/page/README.zh-CN.md#part)\n\n![Image](assets/image.png)\n\n![Remote](https://example.com/remote.png)\n\n<img src=\"https://github.com/user-attachments/assets/472d8152-5e46-4e39-9f09-e77dcd07936a\" alt=\"Animated hero\">\n\n```md\n[Literal](README.zh-CN.md)\n```",
    assets: ["assets/image.png"],
    remoteAssets: ["https://github.com/user-attachments/assets/472d8152-5e46-4e39-9f09-e77dcd07936a"],
    commit
  };
  const nodeMap = new Map([
    [ROOT_KEY, { nodeToken: "root" }],
    ["sections/page/README.zh-CN.md", { nodeToken: "child" }]
  ]);
  const remoteAssets = new Map([
    [page.remoteAssets[0], {
      relativePath: ".feishu-sync-assets/472d8152-5e46-4e39-9f09-e77dcd07936a.gif",
      hash: "remote-gif-hash",
      extension: "gif",
      size: 12
    }]
  ]);
  const first = transformPage(page, nodeMap, temporaryDir, undefined, remoteAssets);
  const second = transformPage(page, nodeMap, temporaryDir, undefined, remoteAssets);
  assert.equal(first.body, second.body);
  assert.equal(first.renderHash, second.renderHash);
  assert.match(first.body, /https:\/\/feishu\.cn\/wiki\/child/);
  assert.match(first.body, /!\[Image\]\(@\.\/assets\/image\.png\)/);
  assert.match(first.body, /\[图片：Remote\]\(https:\/\/example\.com\/remote\.png\)/);
  assert.doesNotMatch(first.body, /!\[Remote\]/);
  assert.match(first.body, /!\[Animated hero\]\(@\.\/\.feishu-sync-assets\/472d8152-5e46-4e39-9f09-e77dcd07936a\.gif\)/);
  assert.match(first.body, /\[Literal\]\(README\.zh-CN\.md\)/);
  assert.doesNotMatch(first.body, /本页由 GitHub 仓库单向同步/);
  assert.doesNotMatch(first.body, /上游提交/);
  assert.equal(first.warnings.length, 1);

  fs.writeFileSync(path.join(temporaryDir, "assets", "image.png"), "image-two");
  const changed = transformPage(page, nodeMap, temporaryDir, undefined, remoteAssets);
  assert.notEqual(first.renderHash, changed.renderHash);
});

test("materializes trusted GitHub attachments as managed GIF assets", async () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-remote-"));
  const url = "https://github.com/user-attachments/assets/472d8152-5e46-4e39-9f09-e77dcd07936a";
  const bytes = Buffer.from("GIF89a-managed-animation");
  const fakeFetch = async (requestedUrl) => {
    assert.equal(requestedUrl, url);
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length), "content-type": "image/gif" }
    });
  };
  const assets = await materializeRemoteAssets([{ remoteAssets: [url] }], temporaryDir, fakeFetch);
  const asset = assets.get(url);
  assert.equal(asset.extension, "gif");
  assert.equal(asset.size, bytes.length);
  assert.equal(fs.readFileSync(path.join(temporaryDir, asset.relativePath)).toString(), bytes.toString());
  cleanupRemoteAssetCache(temporaryDir);
  assert.equal(fs.existsSync(path.join(temporaryDir, ".feishu-sync-assets")), false);

  let fallbackCalled = false;
  const fallbackAssets = await materializeRemoteAssets(
    [{ remoteAssets: [url] }],
    temporaryDir,
    async () => { throw new Error("simulated fetch failure"); },
    async () => {
      fallbackCalled = true;
      return bytes;
    }
  );
  assert.equal(fallbackCalled, true);
  assert.equal(fallbackAssets.get(url).extension, "gif");
  cleanupRemoteAssetCache(temporaryDir);
});

test("fails on unsupported formulas and missing assets", () => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-"));
  fs.writeFileSync(path.join(temporaryDir, ROOT_KEY), "# Root\n\n$$x = 1$$\n");
  assert.throws(() => discoverPages(temporaryDir, commit), /unsupported syntax/);
  fs.writeFileSync(path.join(temporaryDir, ROOT_KEY), "# Root\n\n![Missing](assets/no.png)\n");
  assert.throws(() => discoverPages(temporaryDir, commit), /missing image/);
});

test("round-trips and validates the remote manifest", () => {
  const root = { nodeToken: "root-node", objToken: "root-doc", title: "Root" };
  const manifest = createManifest("space", root, commit);
  const parsed = parseManifest(serializeManifest(manifest));
  assert.deepEqual(parsed, manifest);
  assert.equal(validateManifest(parsed, { spaceId: "space", rootNodeToken: "root-node" }), parsed);
  parsed.pages.other = { ...parsed.pages[ROOT_KEY] };
  assert.throws(() => validateManifest(parsed, { spaceId: "space", rootNodeToken: "root-node" }), /duplicate node token/);
});

test("migrates rename ownership and plans create, update, and archive", () => {
  const root = { nodeToken: "root-node", objToken: "root-doc", title: "Root" };
  const manifest = createManifest("space", root, commit);
  manifest.pages.old = {
    sourcePath: "old",
    parentKey: ROOT_KEY,
    title: "Old",
    nodeToken: "old-node",
    objToken: "old-doc",
    renderHash: "hash",
    revisionId: 1
  };
  migrateRenames(manifest, [{ from: "old", to: "renamed" }]);
  assert.equal(manifest.pages.renamed.nodeToken, "old-node");
  assert.equal(manifest.pages.old, undefined);

  const pages = [
    { stableKey: ROOT_KEY, title: "Root", parentKey: null },
    { stableKey: "new", title: "New", parentKey: ROOT_KEY }
  ];
  const actions = buildActionPlan(pages, manifest, "incremental");
  assert.deepEqual(actions.map((item) => item.action).sort(), ["archive", "create", "update"]);
});

test("recognizes only the verified no-change partial-success shape", () => {
  assert.equal(isNoopPartialSuccess({
    result: "partial_success",
    updated_blocks_count: 0,
    warnings: ["Instruction produced no document changes."]
  }), true);
  assert.equal(isNoopPartialSuccess({
    result: "partial_success",
    updated_blocks_count: 1,
    warnings: ["Instruction produced no document changes."]
  }), false);
  assert.equal(isNoopPartialSuccess({
    result: "partial_success",
    updated_blocks_count: 0,
    warnings: ["image degraded"]
  }), false);
});

test("distinguishes unresolved managed links from GitHub source links", () => {
  assert.equal(hasUnresolvedManagedLink("[Child](sections/00/README.zh-CN.md)"), true);
  assert.equal(hasUnresolvedManagedLink("[Source](https://github.com/example/repo/blob/sha/README.zh-CN.md)"), false);
});

class FakeLarkClient {
  constructor() {
    this.sequence = 1;
    this.nodes = new Map();
    this.documents = new Map();
    this.writeCalls = [];
    this.failDocumentToken = "";
    this.forceGifAsJpeg = false;
    this.addNode({
      nodeToken: "root-node",
      objToken: "root-doc",
      title: "Root",
      parentNodeToken: ""
    });
  }

  addNode(node) {
    this.nodes.set(node.nodeToken, {
      spaceId: "space",
      objType: "docx",
      hasChild: false,
      ...node
    });
    this.documents.set(node.objToken, { content: `# ${node.title}`, revision_id: 0 });
  }

  async getNode(nodeToken) {
    return structuredClone(this.nodes.get(nodeToken));
  }

  async listNodes(_spaceId, parentNodeToken = "") {
    return [...this.nodes.values()]
      .filter((node) => node.parentNodeToken === parentNodeToken)
      .map((node) => structuredClone(node));
  }

  async listSpaces() {
    return [{ space_id: "space", visibility: "private", open_sharing: "closed" }];
  }

  async createNode({ parentNodeToken, title }) {
    const number = this.sequence;
    this.sequence += 1;
    const node = {
      nodeToken: `node-${number}`,
      objToken: `doc-${number}`,
      title,
      parentNodeToken
    };
    this.addNode(node);
    this.writeCalls.push(["create", node.nodeToken]);
    return structuredClone(this.nodes.get(node.nodeToken));
  }

  async renameNode(nodeToken, title) {
    const node = this.nodes.get(nodeToken);
    const document = this.documents.get(node.objToken);
    if (document.content === `# ${node.title}`) {
      document.content = `# ${title}`;
    }
    node.title = title;
    this.writeCalls.push(["rename", nodeToken]);
  }

  async moveNode(nodeToken, targetParentToken) {
    this.nodes.get(nodeToken).parentNodeToken = targetParentToken;
    this.writeCalls.push(["move", nodeToken]);
  }

  async fetchDocument(objToken, { docFormat = "markdown" } = {}) {
    const document = structuredClone(this.documents.get(objToken));
    if (docFormat === "xml") {
      const gifCount = (document.content.match(/\.gif\)/g) ?? []).length;
      const mime = this.forceGifAsJpeg ? "image/jpeg" : "image/gif";
      document.content = Array.from({ length: gifCount }, () => `<img mime="${mime}"/>`).join("\n");
    }
    return document;
  }

  async overwriteDocument(objToken, content) {
    if (objToken === this.failDocumentToken) {
      throw new Error("injected document failure");
    }
    const current = this.documents.get(objToken);
    current.content = content;
    current.revision_id += 1;
    this.writeCalls.push(["overwrite", objToken]);
    return { revision_id: current.revision_id };
  }
}

function createTinySource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-source-"));
  fs.mkdirSync(path.join(directory, "assets"));
  fs.mkdirSync(path.join(directory, "sections", "00-child"), { recursive: true });
  fs.writeFileSync(path.join(directory, "assets", "root.png"), "root-image");
  fs.writeFileSync(
    path.join(directory, ROOT_KEY),
    "# Root\n\n[Child](sections/00-child/README.zh-CN.md)\n\n![Root](assets/root.png)\n"
  );
  fs.writeFileSync(path.join(directory, "sections", "00-child", ROOT_KEY), "# Child\n\nBody\n");
  return directory;
}

test("bootstrap apply checkpoints state and an unchanged rerun is a no-op", async () => {
  const directory = createTinySource();
  const pages = discoverPages(directory, commit);
  const client = new FakeLarkClient();
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir: directory,
    spaceId: "space",
    rootNodeToken: "root-node",
    commit
  });

  const readOnlyPlan = await synchronizer.plan(pages, "full");
  assert.equal(readOnlyPlan.requiresBootstrap, true);
  assert.equal(client.writeCalls.length, 0);

  const first = await synchronizer.apply(pages, "full", { bootstrap: true });
  assert.equal(first.created, 1);
  assert.equal(first.updated, 2);
  const stateNode = [...client.nodes.values()].find((node) => node.title === "同步状态（系统）");
  const firstManifest = parseManifest(client.documents.get(stateNode.objToken).content);
  assert.equal(firstManifest.status, "idle");
  assert.equal(firstManifest.lastSyncedCommit, commit);

  const second = await synchronizer.apply(pages, "incremental");
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 2);
  const verification = await synchronizer.verify(pages);
  assert.equal(verification.verifiedPages, 2);
  client.documents.get("root-doc").revision_id += 1;
  await assert.rejects(() => synchronizer.verify(pages), /remote revision drift detected/);
});

test("verify requires mirrored GIF attachments to remain GIF resources", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-sync-gif-"));
  const url = "https://github.com/user-attachments/assets/472d8152-5e46-4e39-9f09-e77dcd07936a";
  fs.writeFileSync(
    path.join(directory, ROOT_KEY),
    `# Root\n\n<img src="${url}" alt="Animated hero">\n`
  );
  const pages = discoverPages(directory, commit);
  const remoteAssets = new Map([
    [url, {
      relativePath: ".feishu-sync-assets/472d8152-5e46-4e39-9f09-e77dcd07936a.gif",
      hash: "remote-gif-hash",
      extension: "gif",
      size: 12
    }]
  ]);
  const client = new FakeLarkClient();
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir: directory,
    spaceId: "space",
    rootNodeToken: "root-node",
    commit,
    remoteAssets
  });
  await synchronizer.apply(pages, "full", { bootstrap: true });
  assert.equal((await synchronizer.verify(pages)).verifiedPages, 1);
  client.forceGifAsJpeg = true;
  await assert.rejects(() => synchronizer.verify(pages), /expected 1 image\/gif resource/);
});

test("asset bytes trigger an update and removed pages are archived", async () => {
  const directory = createTinySource();
  let pages = discoverPages(directory, commit);
  const client = new FakeLarkClient();
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir: directory,
    spaceId: "space",
    rootNodeToken: "root-node",
    commit
  });
  await synchronizer.apply(pages, "full", { bootstrap: true });

  fs.writeFileSync(path.join(directory, "assets", "root.png"), "changed-image");
  pages = discoverPages(directory, commit);
  const assetReport = await synchronizer.apply(pages, "incremental");
  assert.equal(assetReport.updated, 1);

  fs.writeFileSync(path.join(directory, ROOT_KEY), "# Root\n\n![Root](assets/root.png)\n");
  fs.rmSync(path.join(directory, "sections"), { recursive: true });
  pages = discoverPages(directory, commit);
  const archiveReport = await synchronizer.apply(pages, "incremental");
  assert.equal(archiveReport.archived, 1);
  const archiveNode = [...client.nodes.values()].find((node) => node.title === "归档（系统）");
  const childNode = [...client.nodes.values()].find((node) => node.title === "Child");
  assert.equal(childNode.parentNodeToken, archiveNode.nodeToken);
});

test("a failed page write retains in_progress and the previous successful commit", async () => {
  const directory = createTinySource();
  const firstCommit = "a".repeat(40);
  let pages = discoverPages(directory, firstCommit);
  const client = new FakeLarkClient();
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir: directory,
    spaceId: "space",
    rootNodeToken: "root-node",
    commit: firstCommit
  });
  await synchronizer.apply(pages, "full", { bootstrap: true });

  synchronizer.commit = "b".repeat(40);
  pages = discoverPages(directory, synchronizer.commit);
  client.failDocumentToken = "root-doc";
  await assert.rejects(() => synchronizer.apply(pages, "full"), /injected document failure/);
  const stateNode = [...client.nodes.values()].find((node) => node.title === "同步状态（系统）");
  const manifest = parseManifest(client.documents.get(stateNode.objToken).content);
  assert.equal(manifest.status, "in_progress");
  assert.equal(manifest.lastSyncedCommit, firstCommit);
  assert.equal(manifest.targetCommit, synchronizer.commit);
});

test("bootstrap refuses to claim a root containing unknown nodes", async () => {
  const directory = createTinySource();
  const pages = discoverPages(directory, commit);
  const client = new FakeLarkClient();
  client.addNode({
    nodeToken: "unknown-node",
    objToken: "unknown-doc",
    title: "Manual page",
    parentNodeToken: "root-node"
  });
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir: directory,
    spaceId: "space",
    rootNodeToken: "root-node",
    commit
  });
  await assert.rejects(() => synchronizer.apply(pages, "full", { bootstrap: true }), /unknown children/);
});
