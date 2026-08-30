import { spawn } from "node:child_process";

function findJson(text) {
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // lark-cli may print a human summary before its JSON envelope.
    }
  }
  return null;
}

function isTransient(result) {
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /rate.?limit|timeout|temporar|gateway|connection reset|econnreset|\beof\b|429|502|503|504/.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isNoopPartialSuccess(data) {
  const warnings = data.warnings ?? [];
  const updatedBlocksCount = data.updated_blocks_count ?? data.updatedBlocksCount ?? 0;
  return data.result === "partial_success"
    && updatedBlocksCount === 0
    && warnings.length > 0
    && warnings.every((warning) => /produced no document changes/i.test(warning));
}

export class LarkClient {
  constructor({ cwd, profile = "" } = {}) {
    this.cwd = cwd ?? process.cwd();
    this.profile = profile;
  }

  async run(args, { input = "", retries = 3 } = {}) {
    const fullArgs = [...args];
    if (this.profile) {
      fullArgs.push("--profile", this.profile);
    }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await this.#spawn(fullArgs, input);
      const envelope = findJson(result.stdout) ?? findJson(result.stderr);
      if (result.code === 0 && envelope?.ok === true) {
        return envelope;
      }
      if (result.code === 10) {
        throw new Error("lark-cli requested high-risk confirmation; automatic --yes is forbidden");
      }
      if (attempt < retries && isTransient(result)) {
        await delay(500 * (2 ** attempt));
        continue;
      }
      const error = envelope?.error;
      const detail = error ? `${error.type ?? "error"}/${error.subtype ?? "unknown"}: ${error.message ?? "lark-cli failed"}` : result.stderr.trim();
      throw new Error(detail || `lark-cli failed with exit code ${result.code}`);
    }
    throw new Error("unreachable retry state");
  }

  #spawn(args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn("lark-cli", args, {
        cwd: this.cwd,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  async getNode(nodeToken, spaceId) {
    const envelope = await this.run([
      "wiki", "+node-get", "--node-token", nodeToken,
      "--space-id", spaceId, "--as", "bot", "--format", "json"
    ]);
    return this.#node(envelope.data);
  }

  async listNodes(spaceId, parentNodeToken = "") {
    const args = ["wiki", "+node-list", "--space-id", spaceId, "--page-all", "--page-limit", "0", "--as", "bot", "--format", "json"];
    if (parentNodeToken) {
      args.push("--parent-node-token", parentNodeToken);
    }
    const envelope = await this.run(args);
    const nodes = envelope.data?.nodes ?? envelope.data?.items ?? [];
    return nodes.map((node) => this.#node(node));
  }

  async listSpaces() {
    const envelope = await this.run(["wiki", "+space-list", "--as", "bot", "--format", "json"]);
    return envelope.data?.spaces ?? [];
  }

  async createNode({ spaceId, parentNodeToken = "", title }) {
    const args = ["wiki", "+node-create", "--space-id", spaceId, "--title", title, "--obj-type", "docx", "--as", "bot", "--format", "json"];
    if (parentNodeToken) {
      args.push("--parent-node-token", parentNodeToken);
    }
    const envelope = await this.run(args);
    return this.#node(envelope.data);
  }

  async renameNode(nodeToken, title) {
    await this.run([
      "drive", "+update-title", "--token", nodeToken, "--type", "wiki",
      "--title", title, "--as", "bot", "--format", "json"
    ]);
  }

  async moveNode(nodeToken, targetParentToken) {
    await this.run([
      "wiki", "+move", "--node-token", nodeToken,
      "--target-parent-token", targetParentToken, "--as", "bot", "--format", "json"
    ]);
  }

  async fetchDocument(objToken, { detail = "simple", docFormat = "markdown" } = {}) {
    const envelope = await this.run([
      "docs", "+fetch", "--doc", objToken, "--scope", "full",
      "--detail", detail, "--doc-format", docFormat, "--as", "bot", "--format", "json"
    ]);
    return envelope.data?.document ?? envelope.data;
  }

  async overwriteDocument(objToken, content) {
    const envelope = await this.run([
      "docs", "+update", "--doc", objToken, "--command", "overwrite",
      "--content", "-", "--doc-format", "markdown", "--as", "bot", "--format", "json"
    ], { input: content });
    const data = envelope.data ?? {};
    if (data.result && data.result !== "success") {
      if (isNoopPartialSuccess(data)) {
        const document = await this.fetchDocument(objToken);
        const markers = new Set(content.match(/[0-9a-f]{40}|AWESOME_AGENT_ARCHITECTURE_SYNC_STATE/g) ?? []);
        const remoteContent = document.content ?? "";
        if (markers.size > 0 && [...markers].every((marker) => remoteContent.includes(marker))) {
          return document;
        }
      }
      const details = {
        result: data.result,
        updatedBlocksCount: data.updated_blocks_count ?? data.updatedBlocksCount ?? 0,
        warnings: data.warnings ?? [],
        tips: data.tips ?? ""
      };
      throw new Error(`document update did not fully succeed: ${JSON.stringify(details)}`);
    }
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      throw new Error(`document update warnings: ${data.warnings.join("; ")}`);
    }
    return data.document ?? data;
  }

  #node(value) {
    const node = value?.node ?? value;
    return {
      spaceId: String(node.space_id ?? node.spaceId ?? ""),
      nodeToken: node.node_token ?? node.nodeToken ?? "",
      objToken: node.obj_token ?? node.objToken ?? "",
      objType: node.obj_type ?? node.objType ?? "",
      parentNodeToken: node.parent_node_token ?? node.parentNodeToken ?? "",
      title: node.title ?? "",
      url: node.url ?? "",
      hasChild: Boolean(node.has_child ?? node.hasChild)
    };
  }
}
