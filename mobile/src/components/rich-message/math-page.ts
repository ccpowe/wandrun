import { Directory, File, Paths } from 'expo-file-system';
import { writeAsStringAsync } from 'expo-file-system/legacy';

import { mathDocument, type MathPage, type MathTheme } from '../../lib/math-document.ts';
import { katexScript, katexStyles } from './katex-assets.ts';

let initialized = false;
let nextPage = 0;
let preparation = Promise.resolve();

/** Materialize bundled KaTeX and each page inside its computer's read scope.
 * The WebView may only read this computer's directory; generated HTML can
 * contain server text. Startup removes orphaned pages from interrupted sessions.
 * Preparations serialize ownership while same-directory moves publish complete
 * resources even to pages holding their URLs during cache eviction.
 */
export async function prepareMathPage(body: string, theme: MathTheme, computerId: string): Promise<MathPage> {
  const previous = preparation;
  const turn = Promise.withResolvers<void>();
  preparation = turn.promise;
  await previous;
  try {
    const root = new Directory(Paths.cache, 'wandrun-katex');
    if (!initialized) {
      if (root.exists) root.delete();
      root.create();
      initialized = true;
    } else {
      root.create({ idempotent: true });
    }
    const directory = new Directory(root, encodeURIComponent(computerId));
    directory.create({ idempotent: true });
    const script = new File(directory, 'katex.js');
    const styles = new File(directory, 'katex.css');
    // Cache eviction is allowed even during an app session.
    for (const [file, content] of [[script, katexScript], [styles, katexStyles]] as const) {
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
    const dispose = () => { if (file.exists) file.delete(); };
    try {
      await writeAsStringAsync(file.uri, mathDocument(body, theme, { script: script.uri, styles: styles.uri }));
    } catch (error) {
      dispose();
      throw error;
    }
    return { source: { uri: file.uri }, readAccessUrl: directory.uri, dispose };
  } finally {
    turn.resolve();
  }
}
