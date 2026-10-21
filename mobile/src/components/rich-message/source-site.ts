import { richSourceColors } from './tokens.ts';

const commonCcSecondLevel = /^(?:co|com|org|net|gov|edu|ac|mil)$/;

/** Group a URL hostname into a decorative source mark, never a public-suffix or security boundary.
 * The small ccTLD policy covers common second-level labels; URL safety remains with the existing parser.
 */
export function sourceSite(hostname: string): { site: string; letter: string; color: string } {
  const host = hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  const labels = host.split('.');
  // Numeric addresses are display identities of their own, not registrable domains.
  const address = /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':');
  const hasCommonCcSuffix = labels.length >= 3 && labels[labels.length - 1].length === 2
    && commonCcSecondLevel.test(labels[labels.length - 2]);
  const site = address ? host : labels.slice(-(hasCommonCcSuffix ? 3 : 2)).join('.');
  const letter = site.charAt(site.startsWith('[') ? 1 : 0).toUpperCase();
  let hash = 0;
  for (let index = 0; index < site.length; index++) hash = (Math.imul(hash, 31) + site.charCodeAt(index)) >>> 0;
  return { site, letter, color: richSourceColors[hash % richSourceColors.length] };
}
