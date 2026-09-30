/** Fail before serving a demo whose browser requests would all be rejected. */
export function appOrigin(production: boolean, configured = process.env.APP_ORIGIN): string {
  if (!configured && production) throw new Error('Production requires APP_ORIGIN=https://your-public-domain');
  let origin: URL;
  try { origin = new URL(configured || 'http://localhost:3000'); }
  catch { throw new Error('APP_ORIGIN must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('APP_ORIGIN must contain only the scheme and host, with an optional port');
  }
  if (production && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN for microphone access and secure cookies');
  return origin.origin;
}
