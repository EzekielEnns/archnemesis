# Archnemesis as a package: the built app, the server and the CLI, run by Node 26 (which runs the
# TypeScript as is). bin/archnm-server starts the server; bin/archnm is the CLI.
{ lib, stdenv, nodejs_26, pnpm_10, fetchPnpmDeps, pnpmConfigHook, makeWrapper }:
let
  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let base = baseNameOf path; in
      !(builtins.elem base [ "node_modules" "dist" "dist-static" "data" ".direnv" "result" ".git" ".claude" ".github" ]) && !(lib.hasSuffix ".sqlite" base);
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "archnm";
  version = "0.4.0";
  inherit src;

  nativeBuildInputs = [ nodejs_26 pnpm_10 pnpmConfigHook makeWrapper ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 5;
    # The same on macOS and Linux. Changing pnpm-lock.yaml changes it: set lib.fakeHash, build, copy the "got".
    hash = "sha256-Eu4Gz5Qo6q9VbCH84mL5l2+EQqsCCDQeGy0w+z0zwRA=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm exec vite build
    # The scripts Archnemesis serves for people's machines: the channel and the repo reader.
    pnpm exec vite build -c vite.channel.config.ts
    pnpm exec vite build -c vite.index.config.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/archnm $out/bin
    # What the server and CLI read at run time, as in the Dockerfile: the built app, the code,
    # the JSON schemas, the bundled sign-in providers (ARCHNM_AUTH=gcip) and the dependencies.
    cp -r dist server shared cli schema package.json node_modules $out/lib/archnm/
    mkdir -p $out/lib/archnm/examples
    cp -r examples/auth $out/lib/archnm/examples/
    makeWrapper ${nodejs_26}/bin/node $out/bin/archnm-server \
      --add-flags $out/lib/archnm/server/main.ts --set NODE_ENV production
    makeWrapper ${nodejs_26}/bin/node $out/bin/archnm \
      --add-flags $out/lib/archnm/cli/archnm.ts
    runHook postInstall
  '';

  meta = {
    description = "Architecture as source, drawn live";
    mainProgram = "archnm";
  };
})
