{
  description = "An ACP-compatible coding agent powered by the Claude Agent SDK";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              # The Claude Agent SDK bundles the unfree, prebuilt Claude Code CLI.
              config.allowUnfree = true;
            }
          )
        );
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          claude-agent-acp = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit claude-agent-acp;
          default = claude-agent-acp;
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
