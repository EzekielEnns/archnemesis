// tokens: nobody signs in as themselves; each person or agent holds a token from ARCHNM_TOKENS.
// The core checks those tokens (they work beside every provider), so this one only says what
// the sign-in page shows.
import type { AuthProvider } from "../provider.ts";

export function tokensProvider(): AuthProvider {
  return {
    id: "tokens",
    describe: () => ({
      kind: "token",
      hint: "This Archnemesis needs a token to open. Ask whoever runs it for one.",
    }),
    identify: () => null,
  };
}
