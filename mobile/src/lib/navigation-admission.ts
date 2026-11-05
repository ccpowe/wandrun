export type NavigationAdmission = 'clearing' | 'opening' | 'ready';
export type AdmissionEvent = { type: 'history-cleared' } | { type: 'admission-committed' };

/** Session identity keys this small navigation boundary, not the session or draft hosts. */
export function navigationAdmissionReducer(state: NavigationAdmission, event: AdmissionEvent): NavigationAdmission {
  switch (state) {
    case 'clearing': return event.type === 'history-cleared' ? 'opening' : state;
    case 'opening': return event.type === 'admission-committed' ? 'ready' : state;
    case 'ready': return state;
  }
}
