#!/usr/bin/env bash
# Print the installer as a release publishes it: the template with the
# publishing repository and tag filled in, so a fork's release installs the
# fork's binaries.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=${1:?usage: installer-release.sh owner/name tag}
tag=${2:?usage: installer-release.sh owner/name tag}
if [[ ! $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf 'Invalid repository: %s\n' "$repository" >&2
    exit 1
fi
if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*$ ]]; then
    printf 'Invalid release tag: %s\n' "$tag" >&2
    exit 1
fi
sed -e "s|@REPOSITORY@|$repository|" -e "s|@TAG@|$tag|" "$script_dir/installer.sh"
