# Archnemesis on NixOS, for a tailnet

The flake in this repository has a package and a NixOS module (`nix/module.nix`). The module
runs Archnemesis on 127.0.0.1 and uses `tailscale serve` to put it on the tailnet over HTTPS
at `https://<machine>.<tailnet>:<httpsPort>`. Tailscale adds who is asking to every request
(`ARCHNM_AUTH=tailscale`). Nothing listens on the LAN, and the tailnet name is read from
tailscale at start, so it is never written into a config.

Tailscale must already be running on the machine (`services.tailscale.enable = true`) and
HTTPS enabled for the tailnet.

```nix
# flake.nix of your machine: add the input
inputs.archnm.url = "github:<owner>/<repo>";   # or "git+file:///path/to/archnm"

# configuration.nix
imports = [ inputs.archnm.nixosModules.default ];
services.archnm = {
  enable = true;
  user = "you";                          # own the design files
  designsDir = "/home/you/Archnemesis";  # one folder of files per design
  admins = [ "you@github" ];             # may connect designs to git repos; several are fine
  # editors = [ "you@example.com" ];     # default: everyone on the tailnet edits
};
```

Every option (`port`, `httpsPort`, `stateDir`, `designsDir`, `editors`, `viewers`, `admins`,
`localName`) is described in `nix/module.nix`. Agents on that machine can use
`http://127.0.0.1:5190/mcp`; elsewhere on the tailnet, `https://<machine>.<tailnet>:5190/mcp`.

Settings the options do not cover go in `services.archnm.settings` (any `ARCHNM_*`
variable; `archnm config` lists them), and secrets in a file named by
`services.archnm.environmentFile` (KEY=value lines, kept out of the Nix store).

Upgrading from the old `services.atlas`: the option is still accepted (renamed). An install
from before the rename kept its state in `/var/lib/atlas`. With the default `stateDir`, the
first activation after the upgrade moves that directory to `/var/lib/archnm` once (a rename:
nothing is copied or deleted), renames `atlas.sqlite` to `archnm.sqlite` inside it and gives
the files to the service user. If `/var/lib/archnm` already exists it does nothing. A
`stateDir` you set yourself is left alone.
