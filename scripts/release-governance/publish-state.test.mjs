import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessPublicationState,
  CHANNEL_MANIFESTS,
  renderOutputs,
  verifyManifestPresence,
} from "./publish-state.mjs";

const WINDOWS_ASSETS = ["MangaReader_x64-setup.exe", "latest.json"];
const LINUX_ASSETS = ["MangaReader_amd64.AppImage", "latest-linux-critical.json"];

test("publish-state：正常发布（Draft 且缺对端清单）需要公开并接力", () => {
  const state = assessPublicationState({
    isDraft: true,
    assets: WINDOWS_ASSETS,
    channel: "windows",
  });
  assert.equal(state.published, false);
  assert.equal(state.needPublish, true);
  assert.equal(state.needHandoff, true);
  assert.equal(state.needVerify, true);
  assert.equal(state.ownManifest, "latest.json");
  assert.equal(state.peerManifest, "latest-linux-critical.json");
});

test("publish-state：发布成功但接力失败 → 重跑必须继续补清单", () => {
  const state = assessPublicationState({
    isDraft: false,
    assets: WINDOWS_ASSETS, // latest-linux-critical.json 缺失
    channel: "windows",
  });
  assert.equal(state.published, true);
  assert.equal(state.needPublish, false, "已公开不应再公开一次");
  assert.equal(state.needHandoff, true, "缺对端清单时必须补");
});

test("publish-state：部分失败后重试（自有清单在、对端缺失）", () => {
  const state = assessPublicationState({
    isDraft: false,
    assets: WINDOWS_ASSETS,
    channel: "windows",
  });
  assert.equal(state.hasOwnManifest, true);
  assert.equal(state.hasPeerManifest, false);
  assert.equal(state.needHandoff, true);
  // 此刻校验必须失败：不能报"已完成"。
  assert.deepEqual(verifyManifestPresence(state), {
    ok: false,
    missing: ["latest-linux-critical.json"],
  });
});

test("publish-state：两条清单都缺时校验必须列出全部缺失项", () => {
  const state = assessPublicationState({ isDraft: false, assets: [], channel: "linux" });
  assert.equal(state.hasOwnManifest, false);
  assert.equal(state.hasPeerManifest, false);
  assert.deepEqual(verifyManifestPresence(state).missing, [
    "latest-linux-critical.json",
    "latest.json",
  ]);
});

test("publish-state：重复重试（清单齐全）不产生任何写入动作", () => {
  const state = assessPublicationState({
    isDraft: false,
    assets: [...WINDOWS_ASSETS, "latest-linux-critical.json"],
    channel: "windows",
  });
  assert.equal(state.needPublish, false);
  assert.equal(state.needHandoff, false, "清单齐全时不得再次上传");
  assert.equal(verifyManifestPresence(state).ok, true);
});

test("publish-state：接力补完后的状态转为通过", () => {
  const before = assessPublicationState({
    isDraft: false,
    assets: WINDOWS_ASSETS,
    channel: "windows",
  });
  assert.equal(verifyManifestPresence(before).ok, false);

  const after = assessPublicationState({
    isDraft: false,
    assets: [...WINDOWS_ASSETS, "latest-linux-critical.json"],
    channel: "windows",
  });
  assert.equal(verifyManifestPresence(after).ok, true);
});

test("publish-state：通道隔离——对端清单不会互相误判", () => {
  assert.deepEqual(CHANNEL_MANIFESTS.windows, {
    own: "latest.json",
    peer: "latest-linux-critical.json",
  });
  assert.deepEqual(CHANNEL_MANIFESTS.linux, {
    own: "latest-linux-critical.json",
    peer: "latest.json",
  });

  // Linux 候选即便带着 windows 的 latest.json，也不能算作"自己的清单齐了"。
  const linux = assessPublicationState({
    isDraft: true,
    assets: ["latest.json"], // 只有对端清单
    channel: "linux",
  });
  assert.equal(linux.hasOwnManifest, false);
  assert.equal(linux.hasPeerManifest, true);
  assert.equal(linux.needHandoff, false, "对端清单已在，不需要再接力");
  assert.deepEqual(verifyManifestPresence(linux).missing, ["latest-linux-critical.json"]);
});

test("publish-state：资产既接受字符串也接受对象，未知通道/缺失字段失败", () => {
  const state = assessPublicationState({
    isDraft: true,
    assets: [{ name: "latest.json" }, { name: "latest-linux-critical.json" }],
    channel: "windows",
  });
  assert.equal(state.hasOwnManifest, true);
  assert.equal(state.hasPeerManifest, true);
  assert.equal(state.needHandoff, false);

  assert.throws(() => assessPublicationState({ isDraft: true, channel: "macos" }), /未知发布通道/);
  assert.throws(() => assessPublicationState({ channel: "windows" }), /isDraft 必须是布尔值/);
});

test("publish-state：输出键名与工作流引用保持一致", () => {
  const text = renderOutputs(
    assessPublicationState({ isDraft: false, assets: [], channel: "windows" }),
  );
  for (const key of [
    "published=",
    "has_own_manifest=",
    "has_peer_manifest=",
    "need_publish=",
    "need_handoff=",
    "need_verify=",
  ]) {
    assert.ok(text.includes(key), `缺少输出键 ${key}`);
  }
  assert.ok(text.endsWith("\n"));
});
