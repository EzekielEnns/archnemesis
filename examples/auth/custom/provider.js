// A template for your own sign-in provider: a toy that lets people in with one shared password.
//   docker run … -v ./my-provider.js:/auth/provider.js -e ARCHNM_AUTH=/auth/provider.js \
//     -e SHARED_PASSWORD=… archnm
// A provider only says WHO a request is from. Archnemesis does the rest: the role lists
// (ARCHNM_EDITORS …) match `login`, the cookie, personal tokens for agents, MCP sign-in.
// Rules: identify() is synchronous and must never trust what it did not verify; if it throws, or
// answers null, nobody is signed in.
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createProvider(ctx) {
  // Settings: any ARCHNM_* variable (ctx.env). Fail at start if one is missing.
  const password = ctx.env.ARCHNM_SHARED_PASSWORD;
  if (!password || password.length < 16)
    throw new Error("set ARCHNM_SHARED_PASSWORD (16+ characters)");
  return {
    id: "shared-password", // lowercase; its routes would live at /auth/shared-password/
    // What the app's sign-in page shows: a token field with this line (or { kind: "none" },
    // or { kind: "buttons", buttons: [{ label, start }] } for a redirect flow).
    describe: () => ({ kind: "token", hint: "Ask the team for the shared password." }),
    // `creds.token` is what the person pasted (sent as Authorization: Bearer on every request).
    // Other ways to know who: creds.header("x-some-header"), creds.cookie("name").
    identify(creds) {
      if (!creds.token || !same(creds.token, password)) return null;
      // id is "<prefix>:<login>". Everyone is one person here, so give them a login the
      // lists can name: ARCHNM_EDITORS=team@shared.
      return { id: "shared:team@shared", login: "team@shared", name: "The team" };
    },
  };
}
