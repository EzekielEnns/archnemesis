// The node card's plain helpers (src/ui/NodeCard.tsx): what a pasted reference is, a node's
// notes as a list (they're stored as one markdown doc), a link's name, a typed package.
import type { Ecosystem } from "./model.ts";
import { titleFromUrl } from "./notes.ts";
import type { RefRow } from "./references.ts";

/** What an address or a path looks like, before Enter: so a wrong guess shows. */
export function detectRef(raw: string): RefRow["kind"] | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t))
    return /\.(png|jpe?g|gif|svg|webp)(\?|#|$)/i.test(t) ? "image" : "link";
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(t)) return "image";
  if (/\.(md|markdown)$/i.test(t)) return "doc";
  if (/^[A-Za-z0-9._-]+:[^\s/]/.test(t) || /^[\w.-]+\/[\w./-]+\.\w+(#\S+)?$/.test(t)) return "code";
  return null;
}
/** A node's notes are one markdown doc; each top-level "- " bullet (or paragraph) is a note. */
export function noteItems(md: string): string[] {
  const out: string[] = [];
  for (const block of md.split(/\n(?=- )|\n\s*\n/)) {
    const t = block.replace(/^- /, "").trim();
    if (t) out.push(t);
  }
  return out;
}
/** The doc with a note added on top, as a bullet. */
export function addNote(md: string, text: string): string {
  const items = noteItems(md);
  return [text, ...items].map((t) => `- ${t.replace(/\n/g, "\n  ")}`).join("\n");
}
export function removeNote(md: string, at: number): string {
  return noteItems(md)
    .filter((_, i) => i !== at)
    .map((t) => `- ${t.replace(/\n/g, "\n  ")}`)
    .join("\n");
}

/** A link's name, guessed from its address: docs.rs/sqlx → "sqlx docs", else its title from the URL. */
export function linkName(url: string): string {
  const u = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const [host, ...path] = u.split("/");
  if (/^docs\.|\.readthedocs\.|^developer\./.test(host ?? "") && path[0]) return `${path[0]} docs`;
  return titleFromUrl(url);
}

/** A package typed as "axum", "react@18", "cargo:sqlx@0.8". */
export function parsePackage(
  raw: string,
): { ecosystem?: Ecosystem; name: string; version?: string } | null {
  const m = raw
    .trim()
    .match(
      /^(?:(cargo|npm|pypi|go|maven|nuget|rubygems):)?(@?[\w.-]+(?:\/[\w.-]+)?)(?:@([\w.^~*-]+))?$/,
    );
  return m
    ? {
        ...(m[1] ? { ecosystem: m[1] as Ecosystem } : {}),
        name: m[2]!,
        ...(m[3] ? { version: m[3] } : {}),
      }
    : null;
}

/**
 * Outside tools an app can be: named after one, it's someone else's service (external), the
 * tool is its tech (so its logo), and what it's for says the rest.
 */
export const OUTSIDE_TOOLS: Record<string, string> = {
  Stripe: "Payments",
  PayPal: "Payments",
  Adyen: "Payments",
  Plaid: "Bank accounts",
  Twilio: "SMS",
  SendGrid: "Email",
  Mailgun: "Email",
  Postmark: "Email",
  Resend: "Email",
  Auth0: "Login",
  Okta: "Login",
  Clerk: "Login",
  "Google Maps": "Maps",
  Mapbox: "Maps",
  Slack: "Chat",
  GitHub: "Code hosting",
  Sentry: "Errors",
  Datadog: "Monitoring",
  PostHog: "Product analytics",
  Segment: "Analytics",
  Algolia: "Search",
  Intercom: "Support chat",
  Zendesk: "Support",
  Salesforce: "CRM",
  HubSpot: "CRM",
  Shopify: "Commerce",
  OpenAI: "AI models",
  Anthropic: "AI models",
  Cloudflare: "Edge, DNS",
  Firebase: "App backend",
  Supabase: "App backend",
};

/** "create_order(Cart, UserId) -> Order": its name, and the rest as its signature. */
export function parseSignature(raw: string): { name: string; signature?: string } | null {
  const m = raw.trim().match(/^([A-Za-z_$][\w$.:]*)\s*(\(.*)?$/);
  if (!m) return null;
  const rest = m[2]?.trim().replace(/\s*(?:->|→|=>)\s*/, " -> ");
  return { name: m[1]!, ...(rest && rest !== "()" ? { signature: rest } : {}) };
}
