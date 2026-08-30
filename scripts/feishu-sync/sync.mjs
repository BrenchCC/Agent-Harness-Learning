import crypto from "node:crypto";

import {
  ARCHIVE_TITLE,
  ROOT_KEY,
  STATE_TITLE,
  SYSTEM_TITLE,
  buildActionPlan,
  createManifest,
  hasUnresolvedManagedLink,
  migrateRenames,
  parseManifest,
  serializeManifest,
  topologyHash,
  transformPage,
  validateManifest
} from "./core.mjs";

function shortHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function exactNode(nodes, title) {
  const matches = nodes.filter((node) => node.title === title);
  if (matches.length > 1) {
    throw new Error(`duplicate remote nodes named ${title}`);
  }
  return matches[0] ?? null;
}

function reportTemplate(commit) {
  return {
    sourceCommit: commit,
    created: 0,
    updated: 0,
    moved: 0,
    renamed: 0,
    archived: 0,
    skipped: 0,
    warnings: []
  };
}

export class WikiSynchronizer {
  constructor({ client, sourceDir, spaceId, rootNodeToken, commit, renames = [], remoteAssets = new Map() }) {
    this.client = client;
    this.sourceDir = sourceDir;
    this.spaceId = String(spaceId);
    this.rootNodeToken = rootNodeToken;
    this.commit = commit;
    this.renames = renames;
    this.remoteAssets = remoteAssets;
    this.stateNode = null;
    this.wikiBaseUrl = "https://feishu.cn/wiki";
  }

  async prepare(pages, { bootstrap = false } = {}) {
    const rootNode = await this.client.getNode(this.rootNodeToken, this.spaceId);
    if (rootNode.objType !== "docx") {
      throw new Error("managed root must be a docx wiki node");
    }
    if (rootNode.url) {
      this.wikiBaseUrl = rootNode.url.replace(/\/wiki\/[^/]+.*$/, "/wiki");
    }
    let rootChildren = await this.client.listNodes(this.spaceId, this.rootNodeToken);
    let systemNode = exactNode(rootChildren, SYSTEM_TITLE);
    if (!systemNode) {
      if (!bootstrap) {
        throw new Error("managed state is missing; rerun apply with --bootstrap for a new dedicated root");
      }
      if (rootChildren.length > 0) {
        throw new Error("bootstrap refused because the managed root already has unknown children");
      }
      systemNode = await this.#createBootstrapNode(this.rootNodeToken, SYSTEM_TITLE, "system");
      rootChildren = await this.client.listNodes(this.spaceId, this.rootNodeToken);
    }

    let systemChildren = await this.client.listNodes(this.spaceId, systemNode.nodeToken);
    let stateNode = exactNode(systemChildren, STATE_TITLE);
    let archiveNode = exactNode(systemChildren, ARCHIVE_TITLE);
    if (!stateNode || !archiveNode) {
      if (!bootstrap) {
        throw new Error("managed helper nodes are incomplete; rerun apply with --bootstrap only if this is the intended new root");
      }
      const allowedTitles = new Set([
        STATE_TITLE,
        ARCHIVE_TITLE,
        `__aaa_sync_state_${shortHash("state")}__`,
        `__aaa_sync_archive_${shortHash("archive")}__`
      ]);
      const unknownHelpers = systemChildren.filter((node) => !allowedTitles.has(node.title));
      if (unknownHelpers.length > 0) {
        throw new Error("bootstrap refused because the system node has unknown children");
      }
      stateNode ??= await this.#createBootstrapNode(systemNode.nodeToken, STATE_TITLE, "state");
      archiveNode ??= await this.#createBootstrapNode(systemNode.nodeToken, ARCHIVE_TITLE, "archive");
      systemChildren = await this.client.listNodes(this.spaceId, systemNode.nodeToken);
      stateNode = exactNode(systemChildren, STATE_TITLE);
      archiveNode = exactNode(systemChildren, ARCHIVE_TITLE);
    }
    this.stateNode = stateNode;

    let manifest;
    const stateDocument = await this.client.fetchDocument(stateNode.objToken);
    const stateContent = stateDocument?.content ?? "";
    if (stateContent.includes("AWESOME_AGENT_ARCHITECTURE_SYNC_STATE")) {
      manifest = validateManifest(parseManifest(stateContent), {
        spaceId: this.spaceId,
        rootNodeToken: this.rootNodeToken
      });
    } else {
      const bootstrapContent = stateContent.trim();
      const isDefaultStateTitle = bootstrapContent === `# ${STATE_TITLE}`;
      if (!bootstrap || (bootstrapContent && !isDefaultStateTitle)) {
        throw new Error("state page is not an empty bootstrap page and has no ownership marker");
      }
      manifest = createManifest(this.spaceId, rootNode, this.commit);
      manifest.helpers = {
        system: { nodeToken: systemNode.nodeToken, objToken: systemNode.objToken },
        state: { nodeToken: stateNode.nodeToken, objToken: stateNode.objToken },
        archive: { nodeToken: archiveNode.nodeToken, objToken: archiveNode.objToken }
      };
      await this.#saveManifest(manifest);
    }
    migrateRenames(manifest, this.renames);
    manifest.pages[ROOT_KEY] = {
      ...(manifest.pages[ROOT_KEY] ?? {}),
      sourcePath: ROOT_KEY,
      parentKey: null,
      title: manifest.pages[ROOT_KEY]?.title ?? rootNode.title,
      nodeToken: rootNode.nodeToken,
      objToken: rootNode.objToken,
      renderHash: manifest.pages[ROOT_KEY]?.renderHash ?? "",
      revisionId: manifest.pages[ROOT_KEY]?.revisionId ?? 0
    };
    return { manifest, rootNode, systemNode, archiveNode };
  }

  async plan(pages, mode, options = {}) {
    if (options.bootstrap) {
      throw new Error("plan is read-only; omit --bootstrap and use the returned bootstrap actions");
    }
    const rootNode = await this.client.getNode(this.rootNodeToken, this.spaceId);
    if (rootNode.url) {
      this.wikiBaseUrl = rootNode.url.replace(/\/wiki\/[^/]+.*$/, "/wiki");
    }
    const rootChildren = await this.client.listNodes(this.spaceId, this.rootNodeToken);
    const systemNode = exactNode(rootChildren, SYSTEM_TITLE);
    if (!systemNode) {
      return this.#bootstrapPlan(
        pages,
        [SYSTEM_TITLE, STATE_TITLE, ARCHIVE_TITLE],
        rootChildren.map((node) => `unknown root child: ${node.title}`)
      );
    }
    const systemChildren = await this.client.listNodes(this.spaceId, systemNode.nodeToken);
    const stateNode = exactNode(systemChildren, STATE_TITLE);
    const archiveNode = exactNode(systemChildren, ARCHIVE_TITLE);
    if (!stateNode || !archiveNode) {
      const missing = [];
      if (!stateNode) {
        missing.push(STATE_TITLE);
      }
      if (!archiveNode) {
        missing.push(ARCHIVE_TITLE);
      }
      const knownTitles = new Set([STATE_TITLE, ARCHIVE_TITLE]);
      const blockers = systemChildren
        .filter((node) => !knownTitles.has(node.title) && !node.title.startsWith("__aaa_sync_"))
        .map((node) => `unknown system child: ${node.title}`);
      return this.#bootstrapPlan(pages, missing, blockers);
    }
    const { manifest } = await this.prepare(pages, options);
    const actions = buildActionPlan(pages, manifest, mode);
    const nodeMap = new Map(Object.entries(manifest.pages).map(([key, value]) => [key, value]));
    for (const page of pages) {
      const current = manifest.pages[page.stableKey];
      if (!current) {
        if (!actions.some((item) => item.action === "update" && item.key === page.stableKey)) {
          actions.push({ action: "update", key: page.stableKey, reason: "after_create" });
        }
        continue;
      }
      const rendered = transformPage(page, nodeMap, this.sourceDir, this.wikiBaseUrl, this.remoteAssets);
      if (current.renderHash !== rendered.renderHash && !actions.some((item) => item.action === "update" && item.key === page.stableKey)) {
        actions.push({ action: "update", key: page.stableKey, reason: "hash_changed" });
      }
    }
    const currentTopologyHash = topologyHash(pages);
    return {
      sourceCommit: this.commit,
      previousCommit: manifest.lastSyncedCommit,
      status: manifest.status,
      topologyChanged: manifest.topologyHash !== currentTopologyHash,
      actions
    };
  }

  #bootstrapPlan(pages, missingHelpers, blockers = []) {
    return {
      sourceCommit: this.commit,
      previousCommit: "",
      status: "uninitialized",
      topologyChanged: true,
      requiresBootstrap: true,
      blockers,
      actions: [
        ...missingHelpers.map((title) => ({ action: "create_helper", title })),
        ...pages.filter((page) => page.stableKey !== ROOT_KEY).map((page) => ({ action: "create", key: page.stableKey, title: page.title })),
        ...pages.map((page) => ({ action: "update", key: page.stableKey, reason: "initial_sync" }))
      ]
    };
  }

  async apply(pages, mode, options = {}) {
    const prepared = await this.prepare(pages, options);
    const { manifest, archiveNode } = prepared;
    const report = reportTemplate(this.commit);
    manifest.status = "in_progress";
    manifest.targetCommit = this.commit;
    manifest.pendingCreateKey = "";
    await this.#saveManifest(manifest);

    const pageByKey = new Map(pages.map((page) => [page.stableKey, page]));
    try {
      for (const page of pages.filter((item) => item.stableKey !== ROOT_KEY)) {
        await this.#ensurePageNode(page, manifest, report);
      }
      await this.#reconcileMetadata(pages, manifest, report);

      const nodeMap = new Map(Object.entries(manifest.pages).map(([key, value]) => [key, value]));
      for (const page of pages) {
        const rendered = transformPage(page, nodeMap, this.sourceDir, this.wikiBaseUrl, this.remoteAssets);
        report.warnings.push(...rendered.warnings);
        const remote = manifest.pages[page.stableKey];
        if (mode === "full" || remote.renderHash !== rendered.renderHash) {
          await this.client.overwriteDocument(remote.objToken, rendered.body);
          const writtenDocument = await this.client.fetchDocument(remote.objToken);
          remote.renderHash = rendered.renderHash;
          remote.revisionId = Number(
            writtenDocument.revision_id ?? writtenDocument.revisionId ?? remote.revisionId ?? 0
          );
          remote.revisionVerified = true;
          report.updated += 1;
          await this.#saveManifest(manifest);
        } else {
          report.skipped += 1;
        }
      }

      for (const [key, remote] of Object.entries({ ...manifest.pages })) {
        if (key === ROOT_KEY || pageByKey.has(key)) {
          continue;
        }
        await this.client.moveNode(remote.nodeToken, archiveNode.nodeToken);
        manifest.archives.push({
          sourcePath: remote.sourcePath,
          nodeToken: remote.nodeToken,
          archivedAtCommit: this.commit
        });
        delete manifest.pages[key];
        report.archived += 1;
        await this.#saveManifest(manifest);
      }

      manifest.status = "idle";
      manifest.targetCommit = "";
      manifest.lastSyncedCommit = this.commit;
      manifest.topologyHash = topologyHash(pages);
      manifest.pendingCreateKey = "";
      manifest.lastReport = report;
      await this.#saveManifest(manifest);
      return report;
    } catch (error) {
      manifest.lastReport = { ...report, error: error.message };
      await this.#saveManifest(manifest).catch(() => {});
      throw error;
    }
  }

  async verify(pages) {
    const { manifest, rootNode, systemNode } = await this.prepare(pages);
    if (manifest.status !== "idle" || manifest.lastSyncedCommit !== this.commit) {
      throw new Error("manifest is not at the requested successful commit");
    }
    const rootChildren = await this.client.listNodes(this.spaceId, rootNode.nodeToken);
    const expectedTokens = new Set(Object.values(manifest.pages).map((page) => page.nodeToken));
    expectedTokens.add(systemNode.nodeToken);
    const actualTokens = new Set(rootChildren.map((node) => node.nodeToken));
    for (const token of expectedTokens) {
      if (token === rootNode.nodeToken) {
        continue;
      }
      if (!actualTokens.has(token)) {
        throw new Error(`expected root child is missing: ${token}`);
      }
    }

    const warnings = [];
    const nodeMap = new Map(Object.entries(manifest.pages).map(([key, value]) => [key, value]));
    for (const page of pages) {
      const remote = manifest.pages[page.stableKey];
      if (!remote || remote.title !== page.title) {
        throw new Error(`title or manifest entry mismatch: ${page.stableKey}`);
      }
      const document = await this.client.fetchDocument(remote.objToken);
      const content = document.content ?? "";
      const rendered = transformPage(page, nodeMap, this.sourceDir, this.wikiBaseUrl, this.remoteAssets);
      if (remote.renderHash !== rendered.renderHash) {
        throw new Error(`render hash verification failed: ${page.stableKey}`);
      }
      const revisionId = Number(document.revision_id ?? document.revisionId ?? 0);
      if (remote.revisionVerified && revisionId > 0 && Number(remote.revisionId) !== revisionId) {
        throw new Error(`remote revision drift detected: ${page.stableKey}`);
      }
      if (hasUnresolvedManagedLink(content)) {
        throw new Error(`internal link verification failed: ${page.stableKey}`);
      }
      const expectedImages = page.assets.length + page.remoteAssets.length;
      const actualImages = (content.match(/!\[[^\]]*\]\([^)]+\)|<img\b/g) ?? []).length;
      if (actualImages < expectedImages) {
        warnings.push(`${page.stableKey}: expected ${expectedImages} local image(s), fetched ${actualImages}`);
      }
      if (page.remoteAssets.length > 0) {
        const xmlDocument = await this.client.fetchDocument(remote.objToken, {
          detail: "full",
          docFormat: "xml"
        });
        const xmlContent = xmlDocument.content ?? "";
        const expectedMimes = new Map();
        for (const url of page.remoteAssets) {
          const extension = this.remoteAssets.get(url)?.extension;
          const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
          expectedMimes.set(mime, (expectedMimes.get(mime) ?? 0) + 1);
        }
        for (const [mime, expectedCount] of expectedMimes) {
          const actualCount = xmlContent.split(`mime="${mime}"`).length - 1;
          if (actualCount < expectedCount) {
            throw new Error(`${page.stableKey}: expected ${expectedCount} ${mime} resource(s), fetched ${actualCount}`);
          }
        }
      }
    }
    const spaces = await this.client.listSpaces();
    const space = spaces.find((item) => String(item.space_id) === this.spaceId);
    if (!space || space.visibility !== "private" || space.open_sharing !== "closed") {
      throw new Error("target space privacy verification failed");
    }
    return { verifiedPages: pages.length, warnings };
  }

  async #createBootstrapNode(parentNodeToken, finalTitle, key) {
    const stagingTitle = `__aaa_sync_${key}_${shortHash(key)}__`;
    const children = await this.client.listNodes(this.spaceId, parentNodeToken);
    let node = exactNode(children, stagingTitle);
    if (!node) {
      node = await this.client.createNode({
        spaceId: this.spaceId,
        parentNodeToken,
        title: stagingTitle
      });
    }
    await this.client.renameNode(node.nodeToken, finalTitle);
    return { ...node, title: finalTitle };
  }

  async #ensurePageNode(page, manifest, report) {
    if (manifest.pages[page.stableKey]) {
      return;
    }
    const parent = manifest.pages[page.parentKey];
    if (!parent) {
      throw new Error(`missing managed parent for ${page.stableKey}`);
    }
    const stagingTitle = `__aaa_sync_${shortHash(page.stableKey)}__`;
    manifest.pendingCreateKey = page.stableKey;
    await this.#saveManifest(manifest);
    const children = await this.client.listNodes(this.spaceId, parent.nodeToken);
    let node = exactNode(children, stagingTitle);
    if (!node) {
      node = await this.client.createNode({
        spaceId: this.spaceId,
        parentNodeToken: parent.nodeToken,
        title: stagingTitle
      });
    }
    manifest.pages[page.stableKey] = {
      sourcePath: page.sourcePath,
      parentKey: page.parentKey,
      title: stagingTitle,
      nodeToken: node.nodeToken,
      objToken: node.objToken,
      renderHash: "",
      revisionId: 0
    };
    manifest.pendingCreateKey = "";
    await this.#saveManifest(manifest);
    await this.client.renameNode(node.nodeToken, page.title);
    manifest.pages[page.stableKey].title = page.title;
    report.created += 1;
    await this.#saveManifest(manifest);
  }

  async #reconcileMetadata(pages, manifest, report) {
    for (const page of pages) {
      const remote = manifest.pages[page.stableKey];
      if (remote.title !== page.title) {
        await this.client.renameNode(remote.nodeToken, page.title);
        remote.title = page.title;
        report.renamed += 1;
      }
      if (remote.parentKey !== page.parentKey && page.parentKey) {
        const parent = manifest.pages[page.parentKey];
        await this.client.moveNode(remote.nodeToken, parent.nodeToken);
        remote.parentKey = page.parentKey;
        report.moved += 1;
      }
      remote.sourcePath = page.sourcePath;
    }
    await this.#saveManifest(manifest);
  }

  async #saveManifest(manifest) {
    if (!this.stateNode) {
      throw new Error("state node is not initialized");
    }
    await this.client.overwriteDocument(this.stateNode.objToken, serializeManifest(manifest));
  }
}
