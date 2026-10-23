#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import {
  cleanupRemoteAssetCache,
  discoverPages,
  materializeRemoteAssets,
  summarizeModel
} from "./feishu-sync/core.mjs";
import { LarkClient } from "./feishu-sync/lark-client.mjs";
import { WikiSynchronizer } from "./feishu-sync/sync.mjs";

let transientAssetSourceDir = "";

function parseArgs(argv) {
  const options = {
    command: argv[2] ?? "check",
    mode: "incremental",
    sourceDir: "awesome-agent-architecture",
    report: "artifacts/feishu-sync-report.json",
    bootstrap: false,
    profile: process.env.LARK_PROFILE ?? ""
  };
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bootstrap") {
      options.bootstrap = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function resolveCommit(sourceDir, requestedCommit) {
  return requestedCommit || git(["rev-parse", "HEAD"], sourceDir);
}

function resolveRenames(sourceDir, previousCommit, targetCommit) {
  if (!previousCommit || previousCommit === targetCommit) {
    return [];
  }
  const output = git(["diff", "--name-status", "-M", previousCommit, targetCommit, "--", "README.zh-CN.md", "sections/*/README.zh-CN.md"], sourceDir);
  return output.split("\n").filter(Boolean).flatMap((line) => {
    const [status, from, to] = line.split("\t");
    return status.startsWith("R") ? [{ from, to }] : [];
  });
}

function requireRemoteOptions(options) {
  const spaceId = options.spaceId ?? process.env.FEISHU_SPACE_ID;
  const rootNodeToken = options.rootNodeToken ?? process.env.FEISHU_ROOT_NODE_TOKEN;
  if (!spaceId || !rootNodeToken) {
    throw new Error("FEISHU_SPACE_ID and FEISHU_ROOT_NODE_TOKEN are required for remote commands");
  }
  return { spaceId, rootNodeToken };
}

function writeReport(reportPath, value) {
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function emptyResult(commit, warnings = []) {
  return {
    sourceCommit: commit,
    created: 0,
    updated: 0,
    moved: 0,
    renamed: 0,
    archived: 0,
    skipped: 0,
    warnings
  };
}

function reportContext(options = {}) {
  const sourceDir = path.resolve(options.sourceDir ?? "awesome-agent-architecture");
  let upstreamCommit = options.commit ?? "";
  let parentCommit = "";
  try {
    upstreamCommit ||= resolveCommit(sourceDir, "");
  } catch {
    // Preserve a machine-readable failure report even when Git metadata is unavailable.
  }
  try {
    parentCommit = git(["rev-parse", "HEAD"], path.resolve(sourceDir, ".."));
  } catch {
    // Preserve a machine-readable failure report even when Git metadata is unavailable.
  }
  return { parentCommit, upstreamCommit };
}

async function main() {
  const options = parseArgs(process.argv);
  if (!new Set(["check", "plan", "apply", "verify"]).has(options.command)) {
    throw new Error(`unsupported command: ${options.command}`);
  }
  if (!new Set(["incremental", "full"]).has(options.mode)) {
    throw new Error(`unsupported mode: ${options.mode}`);
  }
  const sourceDir = path.resolve(options.sourceDir);
  transientAssetSourceDir = sourceDir;
  const commit = resolveCommit(sourceDir, options.commit);
  const context = reportContext({ ...options, sourceDir, commit });
  const pages = discoverPages(sourceDir, commit);
  const remoteAssets = await materializeRemoteAssets(pages, sourceDir);
  const model = summarizeModel(pages);
  if (options.command === "check") {
    writeReport(options.report, {
      ok: true,
      command: "check",
      ...context,
      model,
      result: emptyResult(commit)
    });
    process.stdout.write(`${JSON.stringify({ ok: true, commit, model }, null, 2)}\n`);
    return;
  }

  const { spaceId, rootNodeToken } = requireRemoteOptions(options);
  const client = new LarkClient({ cwd: sourceDir, profile: options.profile });
  const synchronizer = new WikiSynchronizer({
    client,
    sourceDir,
    spaceId,
    rootNodeToken,
    commit,
    remoteAssets
  });

  let result;
  if (options.command === "plan") {
    result = await synchronizer.plan(pages, options.mode, { bootstrap: options.bootstrap });
  } else if (options.command === "apply") {
    const preliminary = await synchronizer.prepare(pages, { bootstrap: options.bootstrap });
    synchronizer.renames = resolveRenames(sourceDir, preliminary.manifest.lastSyncedCommit, commit);
    result = await synchronizer.apply(pages, options.mode, { bootstrap: options.bootstrap });
  } else {
    result = await synchronizer.verify(pages);
  }
  const report = {
    ok: true,
    command: options.command,
    mode: options.mode,
    ...context,
    model,
    result
  };
  writeReport(options.report, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const reportPathIndex = process.argv.indexOf("--report");
  const reportPath = reportPathIndex >= 0 ? process.argv[reportPathIndex + 1] : "artifacts/feishu-sync-report.json";
  let options = {};
  try {
    options = parseArgs(process.argv);
  } catch {
    // The original argument error remains the authoritative failure.
  }
  const context = reportContext(options);
  writeReport(reportPath, {
    ok: false,
    command: options.command ?? process.argv[2] ?? "check",
    mode: options.mode ?? "incremental",
    ...context,
    result: {
      ...emptyResult(context.upstreamCommit, [error.message]),
      error: error.message
    }
  });
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  if (transientAssetSourceDir) {
    cleanupRemoteAssetCache(transientAssetSourceDir);
  }
});
