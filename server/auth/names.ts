/** A name from an email until there's a better one: "jack.smith@…" → "Jack Smith". */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((w) => w.replace(/\d+$/, ""))
    .filter(Boolean);
  return (words.length ? words : [local])
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 40);
}
