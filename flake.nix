{
  description = "Archnemesis: architecture as source, drawn live";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        archnm = pkgs.callPackage ./nix/package.nix { };
        default = archnm;
      });

      # services.archnm; see nix/module.nix.
      nixosModules.default = import ./nix/module.nix self;

      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_26 pkgs.pnpm_10 ]; };
      });
    };
}
