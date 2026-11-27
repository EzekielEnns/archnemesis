// The reference for every environment variable: its group, default and meaning. server/config.ts
// reads them (and `archnm config` prints this table); a variable read there that is missing here
// fails server/config.test.ts.
export const GROUPS = {
  listen: "Where the server listens, and the address people use for it",
  paths: "Where it keeps its database and its designs",
  auth: "Who may sign in, and how",
  git: "Designs that follow git repos",
  github: "The GitHub App (pull requests, repo access, sign-in with GitHub)",
  backups: "Copies of the database",
  telemetry: "The log of agents' tool calls and feedback",
  libstats: "Library stats (stars, licence, advisories) from deps.dev and GitHub",
  limits: "Limits and starting content",
  client: "For the archnm command line talking to a server (not read by the server)",
} as const;

type Group = keyof typeof GROUPS;

export interface Variable {
  name: string;
  group: Group;
  /** What it is when unset, as text. */
  default: string;
  doc: string;
  /** Holds a secret: never printed with a value. */
  secret?: true;
}

/** Every variable, in the order `archnm config` prints them. loadConfig reads only these. */
export const VARIABLES = [
  // listen
  {
    name: "ARCHNM_HOST",
    group: "listen",
    default: "127.0.0.1",
    doc: "Address to listen on. Anything but loopback needs a sign-in that does not trust the network: tokens, iap, cloudflare-access, oidc, github, a signed header, or a provider module.",
  },
  { name: "ARCHNM_PORT", group: "listen", default: "5190", doc: "Port to listen on." },
  {
    name: "ARCHNM_PUBLIC_URL",
    group: "listen",
    default: "http://127.0.0.1:<port>",
    doc: "The address people use (behind a proxy or Tailscale): links, cookies, allowed origins and hosts.",
  },
  {
    name: "ARCHNM_ALLOW_OPEN",
    group: "listen",
    default: "unset",
    doc: "yes: let ARCHNM_AUTH=local, tailscale or a plain trusted header listen beyond loopback (the port then trusts whoever reaches it). Yes or no everywhere: 1/true/yes/on, 0/false/no/off.",
  },
  {
    name: "ARCHNM_PERSONAL",
    group: "listen",
    default: "unset",
    doc: "yes: for one person on their own machine: ARCHNM_AUTH=local with ARCHNM_ALLOW_OPEN=yes, whatever ARCHNM_AUTH says (the container image sets it to tokens). There is no sign-in, so publish the port to that machine only (-p 127.0.0.1:5190:5190).",
  },
  {
    name: "ARCHNM_MCP_NAME",
    group: "listen",
    default: "archnm",
    doc: "The name Claude Code knows this server by in the commands the app shows (set it when you also run your own).",
  },
  {
    name: "NODE_ENV",
    group: "listen",
    default: "unset",
    doc: "production: serve the built app from dist/. Otherwise, on loopback, Vite serves the source (dev mode).",
  },
  // paths
  {
    name: "ARCHNM_DB",
    group: "paths",
    default: "data/archnm.sqlite",
    doc: "The SQLite database (history, forks, comments, GitHub sign-ins). :memory: for none.",
  },
  {
    name: "ARCHNM_ROOT",
    group: "paths",
    default: "data/designs",
    doc: "Where each design's files live, one folder per design.",
  },
  {
    name: "ARCHNM_SOURCE_ROOT",
    group: "paths",
    default: "unset",
    doc: "A folder of local clones, <repo>/..., that 'who touched this box' reads when a design has no GitHub owner.",
  },
  // auth
  {
    name: "ARCHNM_AUTH",
    group: "auth",
    default: "local",
    doc: "How people sign in: local (trust everyone, loopback only), tokens, tailscale, iap, cloudflare-access, header (a proxy sets a header), oidc (any OpenID Connect provider), github (the GitHub App), gcip (Google Cloud Identity Platform; the example in examples/auth/gcip), or the path of a provider module (./provider.js, see examples/auth/README.md). server/auth/provider.ts is the contract.",
  },
  {
    name: "ARCHNM_TOKENS",
    group: "auth",
    default: "unset",
    doc: "A JSON file of { token, id, name, kind, roles }. Required for tokens; optional beside every other provider except local (for agents and scripts that cannot sign in).",
  },
  {
    name: "ARCHNM_ADMINS",
    group: "auth",
    default: "empty",
    doc: "Who is an admin: logins, emails, @domain.com or *, comma or space separated. What they match is the provider's login: an email for most, a GitHub username with ARCHNM_AUTH=github. Not for tokens (the file has roles).",
  },
  {
    name: "ARCHNM_EDITORS",
    group: "auth",
    default: "empty (everyone signed in edits)",
    doc: "Who may edit, same format. Setting it together with ARCHNM_VIEWERS shuts out everyone on neither list.",
  },
  {
    name: "ARCHNM_TAILSCALE_USERS",
    group: "auth",
    default: "unset",
    doc: "The old name for ARCHNM_EDITORS, read when that is unset.",
  },
  {
    name: "ARCHNM_VIEWERS",
    group: "auth",
    default: "empty (everyone else reads)",
    doc: "Who may only read, same format.",
  },
  {
    name: "ARCHNM_PUBLIC_LINKS",
    group: "auth",
    default: "off",
    doc: "on: a share link to a design that follows a public GitHub repo works without signing in (a read-only guest, no forking, no agents). Off: every link needs the sign-in and the role lists first. Even on, only designs of public repos are reachable this way.",
  },
  {
    name: "ARCHNM_PROXIES",
    group: "auth",
    default: "0",
    doc: "How many reverse proxies sit in front of the server (a load balancer, Cloudflare, tailscale serve: usually 1). Wrong share links are limited per visitor address; behind a proxy every visitor arrives from the proxy's address, so this says how many X-Forwarded-For entries, counted from the right, were added by proxies you run. 0 believes no header.",
  },
  {
    name: "ARCHNM_OPEN",
    group: "auth",
    default: "unset",
    doc: "yes: with oidc, github, gcip or any provider that anyone on the internet could finish signing in with, let everyone who can in (otherwise ARCHNM_EDITORS and ARCHNM_VIEWERS must be set).",
  },
  {
    name: "ARCHNM_LOCAL_NAME",
    group: "auth",
    default: "desktop",
    doc: "tailscale: the name a request without a tailnet user acts as (an editor, never an admin).",
  },
  {
    name: "ARCHNM_TOKEN_KEY",
    group: "auth",
    default: "unset",
    doc: "A secret that keys the sign-in cookie and encrypts stored GitHub tokens, so a restart keeps people signed in.",
    secret: true,
  },
  {
    name: "ARCHNM_IAP_AUDIENCE",
    group: "auth",
    default: "unset",
    doc: "iap: this service's IAP audience, /projects/<number>/global/backendServices/<id> (or locations/<region>/services/<name>).",
  },
  {
    name: "ARCHNM_CLOUDFLARE_TEAM",
    group: "auth",
    default: "unset",
    doc: "cloudflare-access: your Zero Trust team domain (acme.cloudflareaccess.com, or just acme).",
  },
  {
    name: "ARCHNM_CLOUDFLARE_AUD",
    group: "auth",
    default: "unset",
    doc: "cloudflare-access: the application's Audience (AUD) tag, from the Access application's settings.",
  },
  {
    name: "ARCHNM_HEADER_JWT",
    group: "auth",
    default: "unset",
    doc: "header: the request header that carries a signed JWT (the proxy's), checked on every request. Needs the three below.",
  },
  {
    name: "ARCHNM_HEADER_JWKS_URL",
    group: "auth",
    default: "unset",
    doc: "header: where the proxy publishes the keys that JWT is signed with (a JWK Set; RS256 or ES256).",
  },
  {
    name: "ARCHNM_HEADER_ISSUER",
    group: "auth",
    default: "unset",
    doc: "header: the iss the JWT must carry.",
  },
  {
    name: "ARCHNM_HEADER_AUDIENCE",
    group: "auth",
    default: "unset",
    doc: "header: the aud the JWT must carry.",
  },
  {
    name: "ARCHNM_HEADER_LOGIN_CLAIM",
    group: "auth",
    default: "email",
    doc: "header: the JWT claim holding the login the role lists match.",
  },
  {
    name: "ARCHNM_HEADER_NAME_CLAIM",
    group: "auth",
    default: "name",
    doc: "header: the JWT claim holding the person's name (the login's first part when it has none).",
  },
  {
    name: "ARCHNM_HEADER_LOGIN",
    group: "auth",
    default: "unset",
    doc: "header: instead of a JWT, a header holding the login, believed as it is (X-Forwarded-Email). Only on loopback, like tailscale: nothing but the proxy may reach the port.",
  },
  {
    name: "ARCHNM_HEADER_DISPLAY_NAME",
    group: "auth",
    default: "unset",
    doc: "header: with ARCHNM_HEADER_LOGIN, an optional header holding the person's name.",
  },
  {
    name: "ARCHNM_OIDC_ISSUER",
    group: "auth",
    default: "unset",
    doc: "oidc: the issuer URL; <issuer>/.well-known/openid-configuration must answer. Archnemesis's redirect URI is <public url>/auth/oidc/callback.",
  },
  {
    name: "ARCHNM_OIDC_CLIENT_ID",
    group: "auth",
    default: "unset",
    doc: "oidc: the client id registered for Archnemesis.",
  },
  {
    name: "ARCHNM_OIDC_CLIENT_SECRET",
    group: "auth",
    default: "unset",
    doc: "oidc: that client's secret.",
    secret: true,
  },
  {
    name: "ARCHNM_OIDC_SCOPES",
    group: "auth",
    default: "openid email profile",
    doc: "oidc: the scopes to ask for.",
  },
  {
    name: "ARCHNM_OIDC_LABEL",
    group: "auth",
    default: "Sign in",
    doc: 'oidc: the sign-in button\'s label ("Sign in with Acme").',
  },
  {
    name: "ARCHNM_OIDC_LOGIN_CLAIM",
    group: "auth",
    default: "email",
    doc: "oidc: the ID token claim holding the login the role lists match.",
  },
  {
    name: "ARCHNM_GCIP_PROJECT",
    group: "auth",
    default: "unset",
    doc: "gcip (read by examples/auth/gcip/provider.js): the Identity Platform / Firebase project id.",
  },
  {
    name: "ARCHNM_GCIP_API_KEY",
    group: "auth",
    default: "unset",
    doc: "gcip: the project's web API key (public: it is in every Firebase web page).",
  },
  {
    name: "ARCHNM_GCIP_TENANT",
    group: "auth",
    default: "unset",
    doc: "gcip: accept only people signed in to this tenant.",
  },
  {
    name: "ARCHNM_GCIP_AUTH_DOMAIN",
    group: "auth",
    default: "<project>.firebaseapp.com",
    doc: "gcip: where Firebase's sign-in pages live.",
  },
  // git
  {
    name: "ARCHNM_NEW_IN_GIT",
    group: "git",
    default: "unset (on)",
    doc: "no: new designs are edited directly instead of starting in a git repo of their own on this server.",
  },
  {
    name: "ARCHNM_LITESTREAM_URL",
    group: "git",
    default: "unset",
    doc: "Set where the disk does not last (Litestream keeps the database, not repos): repos on this server are then not offered.",
  },
  {
    name: "ARCHNM_GIT_POLL_MS",
    group: "git",
    default: "30000",
    doc: "How often a followed repo is fetched.",
  },
  {
    name: "ARCHNM_GIT_IDLE_MS",
    group: "git",
    default: "60000",
    doc: "A fork's edits are committed this long after the last one.",
  },
  {
    name: "ARCHNM_GIT_MAX_MS",
    group: "git",
    default: "600000",
    doc: "...and at least this often while edits keep coming.",
  },
  {
    name: "ARCHNM_GIT_LOCAL_REMOTES",
    group: "git",
    default: "unset",
    doc: "yes: a design may follow a repo given as a path on this machine (tests, or one mounted into the container).",
  },
  {
    name: "ARCHNM_GIT_REMOTES",
    group: "git",
    default: "empty (admins only)",
    doc: "Repos editors (not just admins) may connect a design to: host/owner/* patterns, comma separated.",
  },
  {
    name: "ARCHNM_FORGES",
    group: "git",
    default: "empty",
    doc: "Extra hosts that have pull requests, host=kind (github, gitlab, forgejo, gitea), comma separated.",
  },
  {
    name: "GIT_SSH_COMMAND",
    group: "git",
    default: "ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4",
    doc: "The ssh command git uses to reach a remote. The rest of the environment is passed to git as it is.",
  },
  // github
  {
    name: "ARCHNM_GITHUB_URL",
    group: "github",
    default: "https://github.com",
    doc: "GitHub's web address (GitHub Enterprise Server: its own).",
  },
  {
    name: "ARCHNM_GITHUB_API",
    group: "github",
    default: "https://api.github.com (Enterprise: <url>/api/v3)",
    doc: "GitHub's API address.",
  },
  {
    name: "ARCHNM_GITHUB_APP_ID",
    group: "github",
    default: "unset",
    doc: "The GitHub App's id. With the client id, client secret and private key (all of them), the app comes from the environment instead of the database; the id alone changes nothing.",
  },
  {
    name: "ARCHNM_GITHUB_APP_SLUG",
    group: "github",
    default: "empty",
    doc: "The app's slug (its install page).",
  },
  {
    name: "ARCHNM_GITHUB_CLIENT_ID",
    group: "github",
    default: "unset",
    doc: "The app's client id.",
  },
  {
    name: "ARCHNM_GITHUB_CLIENT_SECRET",
    group: "github",
    default: "unset",
    doc: "The app's client secret.",
    secret: true,
  },
  {
    name: "ARCHNM_GITHUB_PRIVATE_KEY",
    group: "github",
    default: "unset",
    doc: "The app's private key (PEM).",
    secret: true,
  },
  {
    name: "ARCHNM_GITHUB_PRIVATE_KEY_FILE",
    group: "github",
    default: "unset",
    doc: "...or a file holding it.",
  },
  {
    name: "ARCHNM_GITHUB_APP_PUBLIC",
    group: "github",
    default: "on",
    doc: "no: the app Archnemesis registers can be installed only by its owner.",
  },
  // backups
  {
    name: "ARCHNM_BACKUP_DIR",
    group: "backups",
    default: "backups/ next to the database",
    doc: "Where database backups go. off: no backups.",
  },
  {
    name: "ARCHNM_BACKUP_HOURS",
    group: "backups",
    default: "6",
    doc: "Hours between backups.",
  },
  {
    name: "ARCHNM_BACKUP_KEEP",
    group: "backups",
    default: "28",
    doc: "How many of the newest backups are kept.",
  },
  {
    name: "ARCHNM_EXPERIMENTS",
    group: "limits",
    default: "none",
    doc: "Behaviour being tried out, by name, comma-separated. offshelf: writes push agents toward existing tools and libraries (each new library's stats when ARCHNM_LIBSTATS is on, a nudge for packages named only in tech and for parts that look hand-written). Unset it to go back.",
  },
  // telemetry
  {
    name: "ARCHNM_TELEMETRY",
    group: "telemetry",
    default: "on",
    doc: "no: no call log (feedback is still kept).",
  },
  {
    name: "ARCHNM_TELEMETRY_DB",
    group: "telemetry",
    default: "telemetry.sqlite next to the database",
    doc: "The log's database file.",
  },
  // libstats
  {
    name: "ARCHNM_LIBSTATS",
    group: "libstats",
    default: "off",
    doc: "yes: look up libraries' stats. It sends library names out, and a private package's name is private.",
  },
  {
    name: "ARCHNM_LIBSTATS_GITHUB_TOKEN",
    group: "libstats",
    default: "unset",
    doc: "A GitHub token that raises the rate limit of those lookups.",
    secret: true,
  },
  // limits
  {
    name: "ARCHNM_MAX_DESIGNS",
    group: "limits",
    default: "100",
    doc: "The most designs one server holds (each is a live document and a watched folder).",
  },
  {
    name: "ARCHNM_EXAMPLES",
    group: "limits",
    default: "on",
    doc: "no: no example shop to start a design from (a team's own server). A fresh server always starts with one empty design.",
  },
  // client
  {
    name: "ARCHNM_SERVER",
    group: "client",
    default: "unset",
    doc: "The server the CLI talks to (the --server flag wins).",
  },
  {
    name: "ARCHNM_TOKEN",
    group: "client",
    default: "unset",
    doc: "The token the CLI sends to that server.",
    secret: true,
  },
  {
    name: "ARCHNM_DIR",
    group: "client",
    default: "./architecture",
    doc: "The folder the CLI works on when none is given.",
  },
] as const satisfies readonly Variable[];

export type Name = (typeof VARIABLES)[number]["name"];
