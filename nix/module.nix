# services.archnm: Archnemesis on a NixOS machine, for its tailnet.
#
# Archnemesis listens on 127.0.0.1 and `tailscale serve` puts it on the tailnet at
# https://<machine>.<tailnet>:<httpsPort>, adding who's asking to every request
# (ARCHNM_AUTH=tailscale). Nothing listens on the LAN. The tailnet name is read from
# tailscale at start, so it never has to be written into a config.
#
# Agents on the machine itself can use http://127.0.0.1:<port>/mcp (they act as
# `localName`); everyone else uses the tailnet address.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.archnm;
  tailscale = "${config.services.tailscale.package}/bin/tailscale";
  ownUser = builtins.elem cfg.user [ "archnm" "atlas" ];
in
{
  # Reads the old name: configs that still say services.atlas keep working.
  imports = [ (lib.mkRenamedOptionModule [ "services" "atlas" ] [ "services" "archnm" ]) ];

  options.services.archnm = {
    enable = lib.mkEnableOption "Archnemesis, the live architecture tool";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.archnm;
      description = "The Archnemesis package.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 5190;
      description = "Loopback port Archnemesis listens on.";
    };
    httpsPort = lib.mkOption {
      type = lib.types.port;
      default = 5190;
      description = "Port `tailscale serve` offers Archnemesis on, over HTTPS, tailnet only.";
    };
    user = lib.mkOption {
      type = lib.types.str;
      default = "archnm";
      description = "User Archnemesis runs as. Set it to yourself to own the design files.";
    };
    designsDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/archnm/designs";
      description = "One folder of files per design (ARCHNM_ROOT).";
    };
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/archnm";
      description = ''
        Where the live database (archnm.sqlite), the git clones and the telemetry log live.
        An install from before the rename kept these in /var/lib/atlas: with the default
        value, if /var/lib/archnm does not exist and /var/lib/atlas does, the next
        activation moves /var/lib/atlas to /var/lib/archnm once (renaming atlas.sqlite to
        archnm.sqlite with it, and handing the files to `user`). Nothing is copied or deleted.
      '';
    };
    editors = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Logins that may edit (\"@domain\" for a whole domain); empty lets everyone on the tailnet edit.";
    };
    viewers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "With editors set: who else may read. Empty: everyone on the tailnet reads.";
    };
    admins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Logins that may also connect designs to git repos and set up the GitHub App. Several are fine.";
    };
    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { ARCHNM_MAX_DESIGNS = "20"; ARCHNM_GIT_REMOTES = "github.com/acme/*"; };
      description = "More settings, as environment variables (`archnm config` lists them). They win over the ones this module sets from its other options.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "A file of KEY=value lines read by systemd, for settings that are secrets (ARCHNM_TOKEN_KEY, ARCHNM_GITHUB_CLIENT_SECRET, ...). Keep it out of the Nix store.";
    };
    localName = lib.mkOption {
      type = lib.types.str;
      default = config.networking.hostName;
      description = "Who requests from this machine itself (no Tailscale identity) act as: an editor, never an admin.";
    };
  };

  config = lib.mkIf cfg.enable {
    # The default user is made here (and "atlas", the old default, if someone named it).
    users.users = lib.mkIf ownUser {
      ${cfg.user} = { isSystemUser = true; group = cfg.user; home = cfg.stateDir; };
    };
    users.groups = lib.mkIf ownUser { ${cfg.user} = { }; };

    # An install from before the rename has its state in /var/lib/atlas: move it to the new
    # default once, before systemd-tmpfiles would create an empty /var/lib/archnm. Runs as
    # root during activation, after the old service is stopped. Only for the default stateDir
    # (a stateDir someone set themselves is theirs). Nothing is copied or deleted: a rename.
    system.activationScripts.archnmLegacyState = lib.mkIf (cfg.stateDir == "/var/lib/archnm") (
      lib.stringAfter [ "users" ] ''
        old=/var/lib/atlas
        new=/var/lib/archnm
        if [ ! -e "$new" ] && [ -d "$old" ]; then
          echo "archnm: moving $old to $new (one time)"
          if mv "$old" "$new"; then
            # The database was atlas.sqlite (with its -wal and -shm); this module names it archnm.sqlite.
            if [ ! -e "$new/archnm.sqlite" ]; then
              for suffix in "" -wal -shm; do
                if [ -e "$new/atlas.sqlite$suffix" ]; then mv "$new/atlas.sqlite$suffix" "$new/archnm.sqlite$suffix"; fi
              done
            fi
            # The old service user ("atlas") may be gone; the files now belong to ${cfg.user}.
            chown -R ${cfg.user}: "$new"
          else
            echo "archnm: could not move $old; it is untouched and Archnemesis will start empty. Move it to $new by hand." >&2
          fi
        fi
      ''
    );

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 ${cfg.user} - -"
      "d ${cfg.designsDir} 0750 ${cfg.user} - -"
    ];

    systemd.services.archnm = {
      description = "Archnemesis";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "tailscaled.service" ];
      wants = [ "network-online.target" ];
      # git for designs that follow a repo (clones live under stateDir/repos); ssh for
      # ssh remotes, using the service user's keys.
      path = [ pkgs.jq pkgs.git pkgs.openssh ];
      environment = {
        ARCHNM_HOST = "127.0.0.1";
        ARCHNM_PORT = toString cfg.port;
        ARCHNM_AUTH = "tailscale";
        ARCHNM_DB = "${cfg.stateDir}/archnm.sqlite";
        ARCHNM_ROOT = cfg.designsDir;
        ARCHNM_LOCAL_NAME = cfg.localName;
        ARCHNM_EDITORS = lib.concatStringsSep "," cfg.editors;
        ARCHNM_VIEWERS = lib.concatStringsSep "," cfg.viewers;
        ARCHNM_ADMINS = lib.concatStringsSep "," cfg.admins;
      } // cfg.settings;
      script = ''
        # The address people use: this machine's tailnet name, read now so it's never in config.
        name=$(${tailscale} status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
        export ARCHNM_PUBLIC_URL="https://$name:${toString cfg.httpsPort}"
        exec ${cfg.package}/bin/archnm-server
      '';
      serviceConfig = {
        User = cfg.user;
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 3;
        # SIGTERM: Archnemesis writes pending files and closes the database.
        KillSignal = "SIGTERM";
        TimeoutStopSec = 15;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.stateDir cfg.designsDir ];
      };
    };

    # Put it on the tailnet. `serve --bg` is remembered by tailscaled; this keeps it set.
    systemd.services.archnm-serve = {
      description = "tailscale serve for Archnemesis";
      wantedBy = [ "multi-user.target" ];
      after = [ "tailscaled.service" "archnm.service" ];
      requires = [ "tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${tailscale} serve --bg --https=${toString cfg.httpsPort} http://127.0.0.1:${toString cfg.port}";
        ExecStop = "${tailscale} serve --https=${toString cfg.httpsPort} off";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };
  };
}
