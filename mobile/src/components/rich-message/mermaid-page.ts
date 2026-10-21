import { Directory, File, Paths } from 'expo-file-system';
import { writeAsStringAsync } from 'expo-file-system/legacy';

import { mermaidDocument } from '../../lib/mermaid-document.ts';
import type { MermaidInput, MermaidPage, MermaidResult, MermaidTheme, MermaidViewport } from '../../lib/mermaid-document.ts';
import { mermaidRendererScript, peleScript } from './pele-assets.ts';

let initialized = false;
let nextPage = 0;
let preparation = Promise.resolve();

/** Publishes one complete HTML page in its computer's read scope. Pele and the
 * fixed renderer are shared per scope and atomically replaced after cache eviction;
 * the caller owns disposal even if preparation resolves after unmount. Startup
 * clears orphaned files from interrupted sessions. The host WebView must allow
 * only the returned page URI as navigation and disable cross-file URL access. */
export async function prepareMermaidPage(input: MermaidInput, theme: MermaidTheme, computerId: string,
  cached?: MermaidResult, viewport?: MermaidViewport): Promise<MermaidPage> {
  const previous = preparation;
  const turn = Promise.withResolvers<void>();
  preparation = turn.promise;
  await previous;
  try {
    const root = new Directory(Paths.cache, 'wandrun-pele-1.6.0');
    if (!initialized) {
      if (root.exists) root.delete();
      root.create();
      initialized = true;
    } else {
      root.create({ idempotent: true });
    }
    const directory = new Directory(root, `computer-${encodeURIComponent(computerId)}`);
    directory.create({ idempotent: true });
    const pele = new File(directory, 'pele.js');
    const renderer = new File(directory, 'mermaid-renderer.js');
    for (const [file, content] of [[pele, peleScript], [renderer, mermaidRendererScript]] as const) {
      if (file.exists) continue;
      const temporary = new File(`${file.uri}.tmp`);
      try {
        await writeAsStringAsync(temporary.uri, content);
        await temporary.move(file);
      } catch (error) {
        if (temporary.exists) temporary.delete();
        throw error;
      }
    }
    const file = new File(directory, `page-${++nextPage}.html`);
    const temporary = new File(`${file.uri}.tmp`);
    try {
      await writeAsStringAsync(temporary.uri,
        mermaidDocument(input, theme, { pele: pele.uri, renderer: renderer.uri }, cached, viewport));
      await temporary.move(file);
    } catch (error) {
      if (temporary.exists) temporary.delete();
      if (file.exists) file.delete();
      throw error;
    }
    return { source: { uri: file.uri }, readAccessUrl: directory.uri,
      dispose: () => { if (file.exists) file.delete(); } };
  } finally {
    turn.resolve();
  }
}
