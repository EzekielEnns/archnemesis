// Technology logos from Simple Icons (CC0), looked up by what's typed in "technology":
// "Postgres" → postgresql, "Go, gRPC" → go. Served as plain SVG, recoloured for the canvas.
import * as simpleIcons from "simple-icons";

interface Icon {
  slug: string;
  title: string;
  svg: string;
  hex: string;
}

const ALIASES: Record<string, string> = {
  postgres: "postgresql",
  pg: "postgresql",
  psql: "postgresql",
  golang: "go",
  node: "nodedotjs",
  nodejs: "nodedotjs",
  next: "nextdotjs",
  nextjs: "nextdotjs",
  k8s: "kubernetes",
  kafka: "apachekafka",
  bigquery: "googlebigquery",
  bq: "googlebigquery",
  pubsub: "googlepubsub",
  gcp: "googlecloud",
  gcs: "googlecloudstorage",
  cloudrun: "googlecloud",
  spanner: "googlecloudspanner",
  firestore: "firebase",
  ts: "typescript",
  js: "javascript",
  py: "python",
  mongo: "mongodb",
  es: "elasticsearch",
  rabbit: "rabbitmq",
  vue: "vuedotjs",
  vuejs: "vuedotjs",
  tailwind: "tailwindcss",
  spring: "spring",
  jdk: "openjdk",
  amazonwebservices: "aws",
  s3: "amazons3",
  lambda: "awslambda",
  dynamodb: "amazondynamodb",
  dynamo: "amazondynamodb",
  sqs: "amazonsqs",
  rds: "amazonrds",
  azure: "microsoftazure",
  mssql: "microsoftsqlserver",
  sqlserver: "microsoftsqlserver",
  cs: "csharp",
  chatgpt: "openai",
  gpt: "openai",
  rn: "reactnative",
  gha: "githubactions",
  otel: "opentelemetry",
  twitter: "x",
};

/**
 * Well-known technologies Simple Icons doesn't carry (taken out over trademark rules):
 * drawn as a lettermark in the brand's colour. `logo` borrows another icon's shape instead.
 */
const EXTRA: { slug: string; title: string; hex: string; mark?: string; logo?: string }[] = [
  { slug: "java", title: "Java", hex: "F89820", logo: "openjdk" },
  { slug: "aws", title: "AWS", hex: "FF9900", mark: "aws" },
  { slug: "amazons3", title: "Amazon S3", hex: "569A31", mark: "S3" },
  { slug: "awslambda", title: "AWS Lambda", hex: "FF9900", mark: "λ" },
  { slug: "amazondynamodb", title: "Amazon DynamoDB", hex: "4053D6", mark: "DDB" },
  { slug: "amazonsqs", title: "Amazon SQS", hex: "FF4F8B", mark: "SQS" },
  { slug: "amazonrds", title: "Amazon RDS", hex: "527FFF", mark: "RDS" },
  { slug: "microsoftazure", title: "Azure", hex: "0078D4", mark: "Az" },
  { slug: "microsoftsqlserver", title: "SQL Server", hex: "CC2927", mark: "SQL" },
  { slug: "csharp", title: "C#", hex: "9B4F96", mark: "C#" },
  { slug: "slack", title: "Slack", hex: "E01E5A", mark: "#" },
  { slug: "linkedin", title: "LinkedIn", hex: "0A66C2", mark: "in" },
  { slug: "openai", title: "OpenAI", hex: "D5DAE3", mark: "AI" },
  { slug: "twilio", title: "Twilio", hex: "F22F46", mark: "Tw" },
  { slug: "sendgrid", title: "SendGrid", hex: "1A82E2", mark: "SG" },
  { slug: "postmark", title: "Postmark", hex: "FFDE00", mark: "PM" },
  { slug: "salesforce", title: "Salesforce", hex: "00A1E0", mark: "SF" },
  { slug: "plaid", title: "Plaid", hex: "D5DAE3", mark: "P" },
  { slug: "segment", title: "Segment", hex: "52BD94", mark: "S" },
  { slug: "amplitude", title: "Amplitude", hex: "1E61F0", mark: "A" },
  { slug: "launchdarkly", title: "LaunchDarkly", hex: "D5DAE3", mark: "LD" },
  { slug: "honeycomb", title: "Honeycomb", hex: "F4B12E", mark: "Hc" },
  { slug: "pinecone", title: "Pinecone", hex: "D5DAE3", mark: "Pc" },
  { slug: "heroku", title: "Heroku", hex: "9E7CC1", mark: "H" },
  { slug: "oracle", title: "Oracle", hex: "F80000", mark: "O" },
  { slug: "ibm", title: "IBM", hex: "0F62FE", mark: "IBM" },
  { slug: "nats", title: "NATS", hex: "27AAE1", mark: "N" },
  { slug: "traefik", title: "Traefik", hex: "24A1C1", mark: "Tr" },
  { slug: "tomcat", title: "Tomcat", hex: "F8DC75", mark: "Tc" },
  { slug: "reactnative", title: "React Native", hex: "61DAFB", logo: "react" },
  { slug: "grpc", title: "gRPC", hex: "4DB6AC", mark: "gRPC" },
];

/** A lettermark: the letters, centred, sized to fit the 24-unit box. */
function lettermark(mark: string): string {
  const size = mark.length <= 1 ? 17 : mark.length === 2 ? 13 : mark.length === 3 ? 10 : 8;
  const esc = mark.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><text x="12" y="12" dy="0.36em" text-anchor="middle" font-family="-apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${size}">${esc}</text></svg>`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const bySlug = new Map<string, Icon>();
const byTitle = new Map<string, Icon>();
for (const v of Object.values(simpleIcons) as unknown[]) {
  if (!v || typeof v !== "object" || !("slug" in v) || !("svg" in v)) continue;
  const icon = v as Icon;
  bySlug.set(icon.slug, icon);
  byTitle.set(norm(icon.title), icon);
}
for (const e of EXTRA) {
  if (bySlug.has(e.slug)) continue;
  const borrowed = e.logo ? bySlug.get(e.logo) : undefined;
  const icon: Icon = {
    slug: e.slug,
    title: e.title,
    hex: e.hex,
    svg: borrowed ? borrowed.svg : lettermark(e.mark ?? e.title[0]!),
  };
  bySlug.set(e.slug, icon);
  if (!byTitle.has(norm(e.title))) byTitle.set(norm(e.title), icon);
}

/** The icon for a technology string, trying each part ("Go, gRPC" → Go first). */
export function iconFor(technology: string): Icon | undefined {
  // A path ("node/", "crates/board/src/hub.rs") says where code lives, not what it's written
  // in: "node/" isn't Node.js. "Go/gRPC" stays a pair of technologies.
  const path = (w: string) =>
    /\/$/.test(w) ||
    (w.match(/\//g) ?? []).length >= 2 ||
    (/\.[a-z0-9]{1,5}$/i.test(w) && w.includes("/"));
  technology = technology
    .split(/\s+/)
    .filter((w) => !path(w))
    .join(" ");
  for (const part of technology.split(/[,·/+&|]| and /i)) {
    const key = norm(part);
    if (!key) continue;
    const hit =
      bySlug.get(ALIASES[key] ?? key) ??
      byTitle.get(key) ??
      bySlug.get(`google${key}`) ??
      bySlug.get(`apache${key}`);
    if (hit) return hit;
    // "Go service", "React app": try the first word.
    const first = norm(part.trim().split(/\s+/)[0] ?? "");
    const loose =
      first && first !== key
        ? (bySlug.get(ALIASES[first] ?? first) ?? byTitle.get(first))
        : undefined;
    if (loose) return loose;
  }
  return undefined;
}

/**
 * Technologies whose names match what's typed, for the picker: names that start with it
 * first, then ones containing it, shortest first ("re" → React, Redis, Redux…).
 */
/** Technologies people actually put on architecture boxes: these rank first in the picker. */
const COMMON = new Set(
  (
    "react nextdotjs vuedotjs angular svelte vite typescript javascript nodedotjs deno bun go python django " +
    "fastapi flask rust openjdk kotlin spring dotnet php laravel ruby rubyonrails elixir swift " +
    "postgresql mysql mariadb sqlite mongodb redis elasticsearch opensearch apachecassandra clickhouse " +
    "snowflake googlebigquery googlecloud googlecloudstorage googlepubsub firebase supabase " +
    "cloudflare vercel netlify docker kubernetes " +
    "terraform nginx apachekafka rabbitmq graphql openapiinitiative stripe auth0 okta clerk " +
    "github gitlab githubactions datadog grafana prometheus sentry posthog anthropic " +
    "tailwindcss nixos linux ubuntu apachespark apacheairflow metabase " +
    // Java and the JVM
    "java openjdk springboot spring hibernate gradle apachemaven scala quarkus apachetomcat tomcat " +
    // other languages and app frameworks
    "csharp clojure haskell erlang dart flutter reactnative expo electron tauri android apple unity " +
    // cloud services without their own logo set
    "aws amazons3 awslambda amazondynamodb amazonsqs amazonrds microsoftazure microsoftsqlserver oracle ibm " +
    "heroku render flydotio railway digitalocean hetzner fastly akamai cloudflareworkers " +
    // data, queues, search
    "neo4j cockroachlabs planetscale neon timescale influxdb duckdb minio apachepulsar nats temporal celery " +
    "algolia meilisearch pinecone " +
    // infra and delivery
    "grpc jenkins circleci argo helm istio envoyproxy caddy traefik keycloak vault consul " +
    // observability
    "newrelic splunk elastic kibana pagerduty opentelemetry jaeger honeycomb " +
    // SaaS people wire in
    "slack discord linkedin x facebook instagram whatsapp telegram youtube zoom gmail googlemaps mapbox " +
    "openai twilio sendgrid mailgun resend postmark salesforce hubspot zendesk intercom shopify paypal plaid " +
    "segment mixpanel amplitude launchdarkly figma notion jira confluence linear wordpress strapi contentful sanity"
  ).split(" "),
);

export function searchIcons(q: string, limit = 8): { title: string }[] {
  const k = norm(q);
  if (!k) return [];
  const starts: Icon[] = [];
  const has: Icon[] = [];
  const alias = ALIASES[k] ? bySlug.get(ALIASES[k]!) : undefined;
  for (const icon of bySlug.values()) {
    const t = norm(icon.title);
    if (t.startsWith(k)) starts.push(icon);
    else if (k.length >= 3 && t.includes(k)) has.push(icon);
  }
  const byLen = (a: Icon, b: Icon) =>
    Number(COMMON.has(b.slug)) - Number(COMMON.has(a.slug)) ||
    a.title.length - b.title.length ||
    a.title.localeCompare(b.title);
  // Common technologies first (starting with it, then containing it), then everything else.
  const common = (i: Icon) => COMMON.has(i.slug);
  const out = [
    ...(alias ? [alias] : []),
    ...starts.filter(common).sort(byLen),
    ...has.filter(common).sort(byLen),
    ...starts.filter((i) => !common(i)).sort(byLen),
    ...has.filter((i) => !common(i)).sort(byLen),
  ];
  // One row per name (Simple Icons has two "Spring"s); the first, better-ranked one wins.
  const titles = [...new Set(out.map((i) => i.title))];
  return titles.slice(0, limit).map((title) => ({ title }));
}

/**
 * The brand colour, unless it's too dark to see on a dark box (GitHub, Next.js are near
 * black): then a light grey.
 */
export function brandColor(icon: Icon): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(icon.hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.18 ? "#d5dae3" : `#${icon.hex}`;
}

/** The SVG for a technology, filled with one colour: `brand` for its own (or a fixed one). */
export function iconSvg(technology: string, fill = "#c7cdd8"): string | null {
  const icon = iconFor(technology);
  if (!icon) return null;
  if (fill === "brand") fill = brandColor(icon);
  return icon.svg.replace("<svg ", `<svg fill="${fill}" width="48" height="48" `);
}
