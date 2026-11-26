// local: the machine itself. Everyone who reaches the port is the one person who runs it, an admin
// (server/config.ts only lets this listen on loopback). The name they chose in the app rides
// along as a hint; an agent on this machine acts for anyone local.
import type { AuthProvider } from "../provider.ts";

export function localProvider(): AuthProvider {
  return {
    id: "local",
    describe: () => ({ kind: "none" }),
    identify(creds) {
      const name = (creds.name ?? "").trim().slice(0, 40);
      return {
        id: `local:${name || "You"}`,
        login: name || "You",
        name,
        machine: { role: "admin", agent: { id: "agent:local", for: "local:*" } },
      };
    },
  };
}
