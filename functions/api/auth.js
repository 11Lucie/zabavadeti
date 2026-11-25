// GET /api/auth – start of the GitHub OAuth flow for Decap CMS (opened in a popup by /admin/).
// Logic lives in lib/oauth.js (outside functions/ so it does not become a route).
import { handleAuth, onlyGet } from '../../lib/oauth.js';

export const onRequestGet = onlyGet(handleAuth);

// Fallback for every other method (POST, PUT, HEAD, …) -> 405. GET is still served correctly
// if the runtime ever dispatches GET here instead of onRequestGet.
export const onRequest = onlyGet(handleAuth);
