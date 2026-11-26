// Sign in with Google Cloud Identity Platform (or plain Firebase Auth), as a custom provider:
// the worked example of examples/auth/README.md. This is what ARCHNM_AUTH=gcip loads, so a
// deployment that already says ARCHNM_AUTH=gcip keeps its settings and changes nothing.
//
// It is written only against the provider contract (server/auth/provider.ts), plus one helper:
// the JWT verifier the server publishes (server/auth/jwt.ts), imported by path. A provider that
// lives outside the repo imports it by its path in the image, /app/server/auth/jwt.ts.
//
//   ARCHNM_GCIP_PROJECT      the project id (e.g. my-project)
//   ARCHNM_GCIP_API_KEY      its web API key (public: it is in every Firebase web page)
//   ARCHNM_GCIP_TENANT       a tenant id, to accept only people signed in to that tenant
//   ARCHNM_GCIP_AUTH_DOMAIN  where Firebase's sign-in pages live (<project>.firebaseapp.com)
//
// Archnemesis's own address must be an authorized domain of the project, or Google refuses to
// sign in there. How it works: the sign-in page's button goes to /auth/gcip/, a page of ours that
// loads Firebase's web SDK from Google's CDN and signs in with Google in a popup; the page posts
// the Firebase ID token to /auth/gcip/signin; we verify it (signature against Google's
// certificates, issuer, audience, expiry, tenant, verified email) and hand the person to
// ctx.sessions.signIn(), which checks the role lists and sets Archnemesis's own cookie.
import { Buffer } from "node:buffer";
import { JwtVerifier, x509Loader } from "../../../server/auth/jwt.ts";

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const SDK = "https://www.gstatic.com/firebasejs/10.14.1";

function settings(env) {
  const project = (env.ARCHNM_GCIP_PROJECT ?? "").trim();
  const apiKey = (env.ARCHNM_GCIP_API_KEY ?? "").trim();
  if (!/^[a-z][a-z0-9-]{4,}$/.test(project))
    throw new Error(
      "ARCHNM_AUTH=gcip needs ARCHNM_GCIP_PROJECT, the Identity Platform / Firebase project id",
    );
  if (!apiKey)
    throw new Error("ARCHNM_AUTH=gcip needs ARCHNM_GCIP_API_KEY, the project's web API key");
  return {
    project,
    apiKey,
    tenant: (env.ARCHNM_GCIP_TENANT ?? "").trim() || null,
    authDomain: (env.ARCHNM_GCIP_AUTH_DOMAIN ?? "").trim() || `${project}.firebaseapp.com`,
  };
}

/** The sign-in page: one button, Firebase's SDK, and the ID token posted back. */
function page(s) {
  const setup = JSON.stringify({
    apiKey: s.apiKey,
    authDomain: s.authDomain,
    projectId: s.project,
    tenant: s.tenant,
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title></head>
<body style="font:16px system-ui,sans-serif;max-width:22rem;margin:20vh auto;padding:0 1rem">
<h1>Archnemesis</h1>
<p>Sign in with your work Google account.</p>
<button id="go" style="font:inherit;padding:.5rem 1rem">Sign in with Google</button>
<p id="err" style="color:#b00020"></p>
<script src="${SDK}/firebase-app-compat.js"></script>
<script src="${SDK}/firebase-auth-compat.js"></script>
<script>
const setup = ${setup};
const back = new URLSearchParams(location.search).get("back") || "/";
const err = document.getElementById("err");
document.getElementById("go").onclick = async () => {
  err.textContent = "";
  try {
    const app = firebase.initializeApp(setup);
    const auth = app.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.NONE);
    auth.tenantId = setup.tenant;
    const cred = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    const idToken = await cred.user.getIdToken();
    await auth.signOut();
    const r = await fetch("/auth/gcip/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken, back }),
    });
    const j = await r.json();
    // Where to go next is the server's answer: the app, or the app's sign-in page with the reason.
    if (j.redirect) location.assign(j.redirect);
    else err.textContent = j.error || "That sign-in didn't work.";
  } catch (e) {
    if (e && e.code === "auth/popup-closed-by-user") return;
    err.textContent = e && e.code === "auth/unauthorized-domain"
      ? "This address isn't allowed to sign in yet: add it to the project's authorized domains."
      : String((e && e.message) || e);
  }
};
</script></body></html>`;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16_384) throw new Error("too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

export function createProvider(ctx) {
  const s = settings(ctx.env);
  const verifier = new JwtVerifier({
    keys: x509Loader(CERTS_URL, ctx.fetch),
    issuer: `https://securetoken.google.com/${s.project}`,
    audience: s.project,
    algorithms: ["RS256"],
  });

  /** The person an ID token belongs to, or null if it doesn't check out. */
  function who(token) {
    const c = verifier.verify(token);
    if (!c || typeof c.sub !== "string" || !c.sub) return null;
    if ((c.firebase?.tenant ?? null) !== s.tenant) return null;
    if (typeof c.email !== "string" || !c.email.includes("@") || c.email_verified !== true)
      return null;
    const login = c.email.toLowerCase();
    return {
      id: `google:${login}`,
      login,
      name: typeof c.name === "string" ? c.name.trim().slice(0, 40) : "",
    };
  }

  return {
    id: "gcip",
    // Anyone with a Google account can finish a Google sign-in: the role lists are the gate.
    openToInternet: true,
    describe: () => ({
      kind: "buttons",
      buttons: [{ label: "Sign in with Google", start: "/auth/gcip/" }],
    }),
    // A Firebase ID token sent as the bearer token works too (scripts).
    identify: (creds) => who(creds.token),
    ready: () => verifier.ready(),
    async routes(req, res, path) {
      if (req.method === "GET" && (path === "/auth/gcip" || path === "/auth/gcip/"))
        return (send(res, 200, "text/html; charset=utf-8", page(s)), true);
      if (req.method === "POST" && path === "/auth/gcip/signin") {
        // JSON only: another site can't send that without asking first (CORS).
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
          return (send(res, 415, "application/json", '{"error":"send JSON"}'), true);
        const b = await readJson(req);
        const identity = who(typeof b.idToken === "string" ? b.idToken : "");
        if (!identity) {
          const error = "that sign-in didn't check out; try again";
          return (
            send(
              res,
              401,
              "application/json",
              JSON.stringify({ error, redirect: ctx.failed(error) }),
            ),
            true
          );
        }
        const r = ctx.sessions.signIn(res, identity, typeof b.back === "string" ? b.back : null);
        res.statusCode = r.ok ? 200 : 403;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ redirect: r.redirect, error: r.error }));
        return true;
      }
      return false;
    },
  };
}
