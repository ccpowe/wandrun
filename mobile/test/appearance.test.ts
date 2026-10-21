import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "test-renderer";

import { AppearanceStore, type AppearancePreferences, type AppearanceStorage } from "../src/lib/appearance.ts";
import { translate, useTranslation } from "../src/lib/i18n.ts";
import { applyLanguage } from "../src/lib/locale-store.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("queued preference changes merge and survive a new store without mixing credentials into device settings", async () => {
  let saved: string | null = null;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const storage: AppearanceStorage = {
    read: async () => saved,
    async write(value) {
      if (first) { first = false; entered.resolve(); await release.promise; }
      saved = value;
    },
  };
  const store = new AppearanceStore(storage, () => {});
  await store.restore();
  const language = store.update({ language: "en" });
  await entered.promise;
  const theme = store.update({ theme: "dark" });
  assert.equal(store.snapshot().saving, true);
  assert.equal(store.snapshot().language, "zh");
  release.resolve();
  await Promise.all([language, theme]);
  const restarted = new AppearanceStore(storage, () => {});
  await restarted.restore();
  assert.deepEqual(restarted.snapshot(), { language: "en", theme: "dark", ready: true, saving: false, error: null });
  assert.deepEqual(JSON.parse(saved!), { language: "en", theme: "dark" });
});

test("a failed preference save leaves the active language, theme, and last durable choice unchanged", async () => {
  const original = { language: "en", theme: "dark" } satisfies AppearancePreferences;
  let active: AppearancePreferences = original;
  const durable = JSON.stringify(original);
  const store = new AppearanceStore({ read: async () => durable, write: async () => { throw new Error("private storage detail"); } }, (next) => { active = next; });
  await store.restore();
  await assert.rejects(store.update({ language: "zh", theme: "light" }));
  assert.deepEqual(active, original);
  assert.equal(store.snapshot().language, "en");
  assert.equal(store.snapshot().theme, "dark");
  assert.equal(store.snapshot().saving, false);
  assert.ok(!store.snapshot().error?.includes("private storage detail"));
});

test("invalid saved preferences are not silently treated as defaults and a repaired read can be retried", async () => {
  let saved = '{"language":"unsupported","theme":"dark"}';
  const store = new AppearanceStore({ read: async () => saved, write: async () => {} }, () => {});
  await assert.rejects(store.restore());
  assert.equal(store.snapshot().ready, false);
  saved = '{"language":"en","theme":"light"}';
  await store.restore();
  assert.equal(store.snapshot().ready, true);
  assert.equal(store.snapshot().language, "en");
  assert.equal(store.snapshot().theme, "light");
});

test("language switching updates existing feedback while preserving mounted input and user content", async () => {
  applyLanguage("zh");
  let changeDraft: ((value: string) => void) | undefined;
  function Surface() {
    const { t, language } = useTranslation();
    const [draft, setDraft] = useState("保存");
    const [error] = useState("无法保存外观设置，请重试。");
    changeDraft = setDraft;
    return createElement("Surface", { language },
      createElement("Label", null, t("保存")),
      createElement("Error", null, t(error)),
      createElement("Draft", null, draft));
  }
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(Surface)));
    await act(async () => changeDraft?.("用户输入 · 保存"));
    await act(async () => applyLanguage("en"));
    assert.equal(root.container.queryAll((node) => node.type === "Surface")[0].props.language, "en");
    assert.equal(root.container.queryAll((node) => node.type === "Label")[0].props.children, "Save");
    assert.equal(root.container.queryAll((node) => node.type === "Draft")[0].props.children, "用户输入 · 保存");
    assert.match(root.container.queryAll((node) => node.type === "Error")[0].props.children, /save appearance settings/i);
    await act(async () => applyLanguage("zh"));
    assert.equal(root.container.queryAll((node) => node.type === "Draft")[0].props.children, "用户输入 · 保存");
  } finally { await act(async () => root.unmount()); applyLanguage("zh"); }
});

test("known system templates translate without translating captured names or swallowing unknown diagnostics", () => {
  const name = "用户工具 · 保存";
  assert.equal(translate("正在调用 {name}", "en", { name }), `Calling ${name}`);
  const formatted = translate("正在调用 {name}", "en", { name });
  assert.equal(translate(formatted, "zh"), `正在调用 ${name}`);
  assert.match(translate("cron 的分钟字段无效，请检查取值范围和格式。", "en"), /minute/i);
  assert.ok(!/\p{Script=Han}/u.test(translate("提示词必须是非空文字", "en")));
  const unknown = "未知服务返回的内容 · Keep {name}";
  assert.equal(translate(unknown, "en"), unknown);
  for (const language of ["zh", "en"] as const) {
    for (const value of ["files", "401 认证无效", "文件在远端环境 ssh-lab，暂不支持下载"]) {
      assert.equal(translate(value, language), value);
    }
  }
  assert.equal(translate("__proto__", "en"), "__proto__");
});
