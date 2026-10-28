#!/usr/bin/env node
/**
 * 发布状态判定：把「Release 是否已公开」与「两条通道的清单是否齐全」拆成
 * 两个独立状态，供 release-publish* 工作流决定每一步该做什么。
 *
 * 背景：此前两个 publish 工作流只要看到 `isDraft=false` 就认为"幂等完成"，
 * 于是「已公开但另一通道清单缺失」的部分失败状态无法被重跑修复——
 * `releases/latest/download/<manifest>` 会一直 404，且工作流仍报成功。
 *
 * 本模块只做纯判定，不联网、不写文件（除 GITHUB_OUTPUT）。
 *
 * 用法：
 *   gh release view "$TAG" --json isDraft,assets > release-state.json
 *   node scripts/release-governance/publish-state.mjs --channel windows --input release-state.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 各通道自有的清单，以及需要为另一通道携带的清单。 */
export const CHANNEL_MANIFESTS = {
  windows: { own: "latest.json", peer: "latest-linux-critical.json" },
  linux: { own: "latest-linux-critical.json", peer: "latest.json" },
};

/**
 * @param {{isDraft: boolean, assets?: Array<string|{name: string}>, channel: string}} input
 */
export function assessPublicationState({ isDraft, assets = [], channel }) {
  const spec = CHANNEL_MANIFESTS[channel];
  if (!spec) throw new Error(`未知发布通道：${channel}（只支持 windows / linux）`);
  if (typeof isDraft !== "boolean") throw new Error("isDraft 必须是布尔值");

  const names = new Set(
    assets.map((item) => (typeof item === "string" ? item : item?.name)).filter(Boolean),
  );

  const published = isDraft === false;
  const hasOwnManifest = names.has(spec.own);
  const hasPeerManifest = names.has(spec.peer);

  return {
    channel,
    ownManifest: spec.own,
    peerManifest: spec.peer,
    published,
    hasOwnManifest,
    hasPeerManifest,
    // 需要公开：仍是 Draft。
    needPublish: !published,
    // 需要补齐另一通道清单：缺就补，已公开也可补（唯一的自救路径）。
    needHandoff: !hasPeerManifest,
    // 校验永远执行：它是"是否真的完成"的唯一判据。
    needVerify: true,
  };
}

/** 把判定结果写成 GitHub Actions step output。 */
export function renderOutputs(state) {
  return [
    `published=${state.published}`,
    `has_own_manifest=${state.hasOwnManifest}`,
    `has_peer_manifest=${state.hasPeerManifest}`,
    `need_publish=${state.needPublish}`,
    `need_handoff=${state.needHandoff}`,
    `need_verify=${state.needVerify}`,
  ].join("\n") + "\n";
}

/** 校验对象是否满足"两条清单都在"，供发布后校验步骤复用。 */
export function verifyManifestPresence(state) {
  const missing = [];
  if (!state.hasOwnManifest) missing.push(state.ownManifest);
  if (!state.hasPeerManifest) missing.push(state.peerManifest);
  return { ok: missing.length === 0, missing };
}

function main(argv) {
  const args = argv.slice(2);
  const channelAt = args.indexOf("--channel");
  const inputAt = args.indexOf("--input");
  const channel = channelAt >= 0 ? args[channelAt + 1] : "";
  const inputPath = inputAt >= 0 ? args[inputAt + 1] : "";

  if (!channel || !inputPath) {
    console.error("[publish-state] 用法：--channel <windows|linux> --input <release.json>");
    return 2;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    console.error(`[publish-state] 无法读取 Release 状态：${error.message}`);
    return 1;
  }

  let state;
  try {
    state = assessPublicationState({
      isDraft: raw.isDraft,
      assets: raw.assets ?? [],
      channel,
    });
  } catch (error) {
    console.error(`[publish-state] ${error.message}`);
    return 1;
  }

  const text = renderOutputs(state);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, text, "utf8");
  else process.stdout.write(text);
  console.log(
    `[publish-state] ${channel}: published=${state.published} own=${state.hasOwnManifest} peer=${state.hasPeerManifest}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv);
}
