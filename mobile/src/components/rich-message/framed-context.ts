import { createContext } from 'react';

/** True inside a framed (interactive) block: nested groups draw no second frame, and edge fades end on card, not page. */
export const RichFramedContext = createContext(false);
