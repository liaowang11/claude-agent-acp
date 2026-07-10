{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_22,
  autoPatchelfHook,
}:

buildNpmPackage (finalAttrs: {
  pname = "claude-agent-acp";
  version = "0.59.0";

  # Restrict the source to the files that actually affect the build, so
  # unrelated changes (CI workflows, README, flake.nix) don't change the
  # derivation hash and invalidate the binary cache.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../package-lock.json
      ../tsconfig.json
    ];
  };

  # FOD of the npm dependencies, derived from `package-lock.json`. Regenerate
  # with `nix run nixpkgs#prefetch-npm-deps -- package-lock.json` (or copy the
  # `got:` hash from a build with `npmDepsHash = lib.fakeHash`) after any lockfile
  # change.
  npmDepsHash = "sha256-Zeh9l58GOWVSwNAlCnUkKgND2IMEor4WXDiw+w+NGq8=";

  nodejs = nodejs_22;

  # `npm ci` needs to populate its content-addressed cache during the build.
  makeCacheWritable = true;

  # The build step is `tsc` (the package.json "build" script), which emits the
  # `dist/` that the `claude-agent-acp` bin points at. buildNpmPackage runs it
  # automatically; it is spelled out here as documentation.
  npmBuildScript = "build";

  # The Claude Agent SDK spawns a prebuilt, bun-compiled `claude` executable
  # shipped as a platform-specific optional npm dependency (~200 MB), resolved at
  # runtime by `claudeCliPath()`. Stripping it breaks the embedded bun runtime;
  # on Linux its ELF interpreter and rpath must be pointed at nix libraries.
  # Only the host platform's optional dependency is installed by `npm ci`, so
  # autoPatchelfHook never sees the other platforms' binaries.
  dontStrip = true;
  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  meta = {
    description = "An ACP-compatible coding agent powered by the Claude Agent SDK";
    homepage = "https://github.com/agentclientprotocol/claude-agent-acp";
    license = with lib.licenses; [
      asl20 # the claude-agent-acp sources
      unfree # the bundled, prebuilt Claude Code CLI
    ];
    mainProgram = "claude-agent-acp";
    sourceProvenance = with lib.sourceTypes; [
      fromSource # our TypeScript, compiled during the build
      binaryNativeCode # the bundled `claude` executable
    ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
})
