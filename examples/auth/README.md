# Sign-in providers

Archnemesis does not know how your company signs people in. A **provider** is a small module that
turns a request into "who is this": a login (usually an email) and a name. Everything else is the
same whichever provider you use, and is not the provider's business:

- who may do what: `ARCHNM_ADMINS`, `ARCHNM_EDITORS`, `ARCHNM_VIEWERS` match the login;
- the session cookie that keeps a browser signed in after a redirect flow;
- personal tokens (people make them in the app) and the `ARCHNM_TOKENS` file, for agents and
  scripts; both work beside every provider;
- Claude Code signing in over MCP OAuth (when your sign-in has a button);
- "an agent is at most an editor".

There is one sign-in page, drawn by the app. A provider only says what it needs on it.

## The contract

The contract is `server/auth/provider.ts` (read its comments). A module exports one function:

```js
export function createProvider(ctx) {
  return {
    id: "my-sso", // lowercase letters, digits, dashes; its routes live at /auth/my-sso/
    describe: () => ({ kind: "none" }), // see below
    identify(creds) {
      return null;
    }, // sync; who is this request from?
    // optional:
    openToInternet: true, // anyone on the internet could finish signing in: see below
    async ready() {}, // load keys; reject to stop the server at start, with your message
    async routes(req, res, path) {
      return false;
    }, // anything under /auth/my-sso/; true if you answered
  };
}
```

`describe()` is what the sign-in page shows:

| `describe()` returns                               | The page shows                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `{ kind: "none" }`                                 | nothing to do: a proxy already signed people in                                                                   |
| `{ kind: "token", hint }`                          | a field to paste a token; `hint` is the line above it                                                             |
| `{ kind: "buttons", buttons: [{ label, start }] }` | one button each; `start` is a path on this server the browser goes to (`/auth/my-sso/start`), with `?back=` added |

You never supply HTML or styling for that page. A provider that needs a page of its own for a vendor's
SDK (like the gcip example) serves it from `routes`, and the button leads there.

`identify(creds)` gets `{ token, header(name), cookie(name), name }` and returns
`{ id, login, name }` or `null`. `id` is `<prefix>:<login>` (e.g. `google:sam@example.com`).
It is **synchronous** (it also runs for WebSocket upgrades): load keys in `ready()`, and say `null`
until they are there. If it throws, or returns something malformed, nobody is signed in.

After a browser flow, finish with `ctx.sessions.signIn(res, identity, back)`: Archnemesis checks the
role lists, sets its cookie and returns `{ ok, redirect }`, the address to send the browser to (the
app, back where they were going, or the app's sign-in page with the reason). `ctx.failed(message)` is
that same page for a failure of your own. `ctx.safeRedirect(path)` makes any other redirect target
safe (same site only).

What the context also holds: `ctx.env` (the `ARCHNM_*` variables: take your settings from here),
`ctx.config` (`publicUrl`, `loopback`, `secure`), `ctx.log`, `ctx.fetch`. Nothing else: a provider
does not reach into the server's database or live documents.

**`openToInternet: true`** says that anyone on the internet could finish your sign-in (a public
identity provider). Archnemesis then refuses to start unless `ARCHNM_EDITORS` and `ARCHNM_VIEWERS`
(or `ARCHNM_ADMINS`) restrict who gets in, or `ARCHNM_OPEN=yes` says everyone may.

Rules of thumb: never trust a header you did not verify (a header is only evidence where nothing
but your proxy can reach the port, or when it carries a signature you check); keep redirect
`state` and a `nonce` single-use, short-lived and tied to the browser that started the flow; fail
closed.

### Verifying JWTs

`server/auth/jwt.ts` is a small dependency-free verifier (RS256 and ES256; issuer, audience,
expiry, key rotation, nonce). In the container it is at `/app/server/auth/jwt.ts`:

```js
import { JwtVerifier, jwksLoader } from "/app/server/auth/jwt.ts";
const v = new JwtVerifier({ keys: jwksLoader(url, ctx.fetch), issuer, audience });
// in ready():  await v.ready();      in identify():  const claims = v.verify(token);
```

(`x509Loader` reads a `{ kid: certificate }` document, which is what Firebase publishes.) You can also
bring your own library: the container runs a plain `node_modules`-less app, so mount what you need.

## Running your own

```sh
docker run -p 5190:5190 -v archnm-data:/data -v architecture:/architecture \
  -v ./my-provider.js:/auth/provider.js:ro -e ARCHNM_AUTH=/auth/provider.js \
  -e ARCHNM_EDITORS=@yourcompany.com archnm
```

`custom/provider.js` is a 40-line template (a shared password). `gcip/provider.js` is a full
example: Google Cloud Identity Platform with a page of its own, written against this contract
only. `ARCHNM_AUTH=gcip` loads it (its settings are `ARCHNM_GCIP_PROJECT`, `ARCHNM_GCIP_API_KEY`,
`ARCHNM_GCIP_TENANT`, `ARCHNM_GCIP_AUTH_DOMAIN`), so existing installs keep working.

## Which built-in covers which product

| Product                                   | Use                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oauth2-proxy                              | `header` with `ARCHNM_HEADER_LOGIN=X-Forwarded-Email` (Archnemesis on loopback behind it), or `ARCHNM_HEADER_JWT=X-Forwarded-Access-Token`-style signed headers with the JWKS settings (`--pass-authorization-header`) |
| Pomerium                                  | `header`: `ARCHNM_HEADER_JWT=X-Pomerium-Jwt-Assertion`, `ARCHNM_HEADER_JWKS_URL=https://<authenticate domain>/.well-known/pomerium/jwks.json`, issuer and audience your route's domain                                 |
| Authelia                                  | as an OIDC provider: `oidc`. Behind its forward-auth: `header` with `ARCHNM_HEADER_LOGIN=Remote-Email`, on loopback                                                                                                    |
| Authentik                                 | `oidc` (issuer `https://<host>/application/o/<slug>/`). Its proxy outpost: `header` with `ARCHNM_HEADER_LOGIN=X-authentik-email` on loopback                                                                           |
| Keycloak                                  | `oidc` (issuer `https://<host>/realms/<realm>`)                                                                                                                                                                        |
| Google (accounts)                         | `oidc` with issuer `https://accounts.google.com`; for Google Workspace on Cloud Run / load balancer: `iap`                                                                                                             |
| Google Cloud Identity Platform / Firebase | `gcip` (this folder)                                                                                                                                                                                                   |
| Okta                                      | `oidc` (issuer `https://<org>.okta.com` or the custom authorization server's)                                                                                                                                          |
| Cloudflare Access                         | `cloudflare-access` with `ARCHNM_CLOUDFLARE_TEAM` and `ARCHNM_CLOUDFLARE_AUD`                                                                                                                                          |
| Tailscale                                 | `tailscale` (`tailscale serve` adds the identity; Funnel traffic is refused)                                                                                                                                           |
| GitHub                                    | `github` (the lists name GitHub logins)                                                                                                                                                                                |

The header names above are the products' defaults as documented by them; check them against your version. The header and OIDC settings are in `archnm config`. The OIDC redirect URI to register is
`<ARCHNM_PUBLIC_URL>/auth/oidc/callback`. The `oidc` provider checks RS256 and ES256 ID tokens; an
issuer that signs with another algorithm needs a provider of your own.
