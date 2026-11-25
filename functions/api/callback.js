// GET /api/callback – GitHub redirects here; exchanges the code for a token and hands it
// to the Decap CMS window via the postMessage handshake. Logic lives in lib/oauth.js.
import { handleCallback, onlyGet } from '../../lib/oauth.js';

export const onRequestGet = onlyGet(handleCallback);

// Fallback for every other method -> 405 (GET still handled correctly if dispatched here).
export const onRequest = onlyGet(handleCallback);
