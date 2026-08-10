# Third-party command-line assets

Happier downloads these active command-line assets from fixed HTTPS URLs. Every source archive is pinned by byte size and SHA-256 before inspection. The complete archive is preflighted before writes, selected members are allowlisted, and each extracted member is checked by size and SHA-256 again. The repository does not carry replacement binary archives at `HEAD`.

## Difftastic 0.64.0

- Project: https://github.com/Wilfred/difftastic
- Tag: `0.64.0`
- Commit: `484708c6d3b7b4dfa25f0d946748c58195436825`
- License: MIT; see `licenses/difftastic-LICENSE`
- Inputs: the five official GitHub Release assets named in `third-party-assets.json`

The binaries in the former repository-local archives were compared with the single members in these official assets and were byte-identical. The fixed-download assets are now the source of truth.

## Anthropic ripgrep vendor bundle from Claude Code 1.0.67

- Package: `@anthropic-ai/claude-code@1.0.67`
- npm tarball: https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-1.0.67.tgz
- Package gitHead: `42aced65b965ec5911daabec2a47e4d7ee2a997f`
- npm SHA-1: `f2784806bfcbe11a54e6fbe2bf605e04a1293289`
- npm integrity: `sha512-r7CfhbKBXgaL5Wo0BIh08SOahFYQPcbHCNnMLtse7iDd2IVBWeOxqoiqQvzRQ0wTCiqLTshRbnmLWHyP4AbuyQ==`
- Vendor license receipt: `package/vendor/ripgrep/COPYING`; see `licenses/ripgrep-LICENSE`

The selected `rg`/`rg.exe` and `ripgrep.node` members are pinned separately for every supported target. `ripgrep.node` is described as an Anthropic vendor-bundle member; this project does not claim that it is an official BurntSushi/ripgrep Release asset or assign it an unverified upstream ripgrep version.

## Zellij 0.44.3

- Project: https://github.com/zellij-org/zellij
- Tag: `v0.44.3`
- Commit: `55a2121b73dce4be624cda425a960e893000777c`
- License: MIT; see `licenses/zellij-LICENSE`
- Inputs: the five official `zellij-no-web` GitHub Release assets named in `third-party-assets.json`

Windows arm64 remains explicitly unsupported because this release does not provide the required upstream binary set.
