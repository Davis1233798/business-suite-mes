Moby rootless Docker setup scripts

- Upstream: https://github.com/moby/moby
- Release tag: docker-v29.1.3
- Signed tag object: 3ac9309249510376baefa3b747986b5eeee977f9
- Dereferenced commit: fbf3ed25f893e6ce21336f1101590e40a13934f4
- License: Apache-2.0 (see LICENSE from the same tag)
- `dockerd-rootless.sh` SHA-256: 8eb00d61b5e78ffc0dcd628f056389b5859cc61d6fe3ce17b4a3a4b08143c8a5
- `dockerd-rootless-setuptool.sh` SHA-256: e68ef6550fea1b5c01b5cc7a400a6b44ee28159d7714758c3845759e03e079dc

The scripts are copied from `contrib/dockerd-rootless.sh` and
`contrib/dockerd-rootless-setuptool.sh` at the tag above. The release tag
signature was verified against GitHub's API when this vendor snapshot was
prepared. Provisioning checks the file digests before installation.
