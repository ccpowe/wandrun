import type { GatewayApi } from '../gateway/api.ts';
import type { ChatVisitLease } from './chat-visit.ts';
import { uploadDraftAccess, type UploadDraftAccess, type UploadDraftController } from './upload-drafts.ts';

/** Hold the ready controller until the real view subscribes, or its source visit is revoked.
 * No second controller, navigation result queue, refocus, or render-time acquisition. */
export function chatUploadHandoff(api: GatewayApi, id: string, controller: UploadDraftController, lease: ChatVisitLease): UploadDraftAccess {
  const releaseHold = controller.subscribe(() => {});
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    stopWatching();
    releaseHold();
  };
  const stopWatching = lease.owner.subscribe(() => { if (!lease.owner.allows(lease)) release(); });
  const view = uploadDraftAccess(api, id, id, controller);
  return {
    getSnapshot: () => lease.owner.allows(lease) ? view.getSnapshot() : null,
    subscribe(changed) {
      if (!lease.owner.allows(lease)) { release(); return () => {}; }
      try { return view.subscribe(changed); }
      finally { release(); }
    },
  };
}
