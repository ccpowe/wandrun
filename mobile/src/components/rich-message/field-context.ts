import { createContext } from 'react';

/** A Field owns visible labels; only its matching bound value replaces a submitted input's value. */
export const RichFieldContext = createContext<false | { boundStateKey?: string }>(false);
