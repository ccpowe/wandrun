import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "test-renderer";
import ts from "typescript";

import type { UploadItem } from "../src/lib/upload-draft-state.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  var composerTestLanguage: "zh" | "en";
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const platform: Record<string, string> = {
  "react-native": `export const View='View', Text='Text', TextInput='TextInput', ScrollView='ScrollView', Pressable='Pressable';
    export const Platform={OS:'web'};`,
  "lucide-react-native": "export const ArrowUp='ArrowUp',Quote='Quote',RotateCw='RotateCw',X='X';",
  "@/components/chat/attachment-picker-menu.tsx": "export const AttachmentPickerMenu='AttachmentPickerMenu';",
  "@/components/file-type-icon.tsx": "export const FileTypeIcon='FileTypeIcon';",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='UiText';",
  "./locale-store.ts": `export const getLanguage=()=>globalThis.composerTestLanguage;
    export const getLocale=()=>getLanguage()==='zh'?'zh-CN':'en-US';
    export const useLanguage=getLanguage;`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in platform) return { url: `data:text/javascript,${encodeURIComponent(platform[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      for (const extension of [".tsx", ".ts"]) {
        if (existsSync(fileURLToPath(url) + extension)) return { url: url.href + extension, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(fileURLToPath(url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
    ).outputText };
    return nextLoad(url, context);
  },
});
// Native host shims must register before importing the TSX components.
const { Composer } = await import("../src/components/chat/composer.tsx");

const composerProps = { draft: "", onChangeDraft: () => {}, quote: null, onCancelQuote: () => {},
  attachments: [] as UploadItem[], uploadError: null, onPick: () => {}, onRetry: () => {}, onRemove: () => {},
  working: true, stopping: false, onSend: () => {}, onStop: () => {} };
const node = (root: Root, type: string) => root.container.queryAll((entry) => entry.type === type)[0];
const probe = (root: Root) => root.container.queryAll((entry) => entry.type === "Text" && !!entry.props.onLayout)[0];
const hints = (root: Root) => root.container.queryAll((entry) => entry.type === "Text" && !entry.props.onLayout);

// The renderer cannot measure fonts: deliver measured text heights as native/Web onLayout would.
test("empty hints never grow the composer in either language or mode, including disabled hints", async () => {
  const root = createRoot({ textComponentTypes: ["Text", "UiText"] });
  try {
    for (const language of ["zh", "en"] as const) {
      globalThis.composerTestLanguage = language;
      for (const mode of [{ working: true }, { working: false }, { disabledReason: "连接网关后可用" }]) {
        await act(async () => root.render(createElement(Composer, { ...composerProps, ...mode })));
        const hint = hints(root)[0];
        assert.equal(hints(root).length, 1);
        assert.equal(hint.props.numberOfLines, 1);
        assert.equal(hint.props.ellipsizeMode, "tail");
        assert.equal(hint.props.pointerEvents, "none");
        assert.equal(hint.props.accessible, false);
        assert.equal(probe(root).props.children, "");
        // Even an oversized empty-text measurement must not make a hint grow the input.
        await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 96 } } }));
        assert.equal(node(root, "TextInput").props.style.height, 40);
      }
    }
  } finally { await act(async () => root.unmount()); }
});

test("only the draft grows and shrinks with wrapping, preserves trailing blank lines, and clears immediately", async () => {
  const root = createRoot({ textComponentTypes: ["Text", "UiText"] });
  try {
    await act(async () => root.render(createElement(Composer, { ...composerProps, draft: "One\ntwo\n" })));
    assert.equal(hints(root).length, 0);
    assert.equal(probe(root).props.children, "One\ntwo\n\u200b");
    await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 48 } } }));
    assert.equal(node(root, "TextInput").props.style.height, 64);
    // Width changes reflow real input without requiring a draft change.
    await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 72 } } }));
    assert.equal(node(root, "TextInput").props.style.height, 88);
    await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 192 } } }));
    assert.equal(node(root, "TextInput").props.style.height, 120);
    await act(async () => root.render(createElement(Composer, { ...composerProps, draft: "Short", working: false })));
    await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 24 } } }));
    assert.equal(node(root, "TextInput").props.style.height, 40);
    await act(async () => probe(root).props.onLayout({ nativeEvent: { layout: { height: 72 } } }));
    await act(async () => root.render(createElement(Composer, composerProps)));
    // Clearing cannot wait for another native layout callback.
    assert.equal(node(root, "TextInput").props.style.height, 40);
    assert.equal(hints(root).length, 1);
  } finally { await act(async () => root.unmount()); }
});

