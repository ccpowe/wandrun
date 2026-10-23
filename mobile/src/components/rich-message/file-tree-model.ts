export type FileTreeInput = { path: string; kind?: 'folder' | 'file'; note?: string; collapsed?: boolean };
export type FileTreeNode = { path: string; name: string; kind: 'folder' | 'file'; note?: string; collapsed?: boolean; children: FileTreeNode[] };

/** Complete implicit ancestor folders at their first appearance. A later explicit folder enriches
 * the same node in place, so neither descendants nor siblings are reordered. Inputs are validated
 * by the UI schema before reaching this presentation model.
 */
export function buildFileTree(nodes: readonly FileTreeInput[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const byPath = new Map<string, FileTreeNode>();
  for (const input of nodes) {
    const parts = input.path.replace(/\/$/, '').split('/');
    let siblings = roots;
    let path = '';
    for (let index = 0; index < parts.length; index++) {
      path = path ? `${path}/${parts[index]}` : parts[index];
      let current = byPath.get(path);
      if (!current) {
        current = { path, name: parts[index], kind: 'folder', children: [] };
        byPath.set(path, current);
        siblings.push(current);
      }
      if (index < parts.length - 1) current.kind = 'folder';
      if (index === parts.length - 1) {
        current.kind = input.kind ?? (input.path.endsWith('/') || current.children.length ? 'folder' : 'file');
        current.note = input.note;
        current.collapsed = input.collapsed;
      }
      siblings = current.children;
    }
  }
  return roots;
}
