#!/usr/bin/env bash
# Install trusted Debian packages by extraction, without root or system changes.
set -euo pipefail

cfd_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export CFD_RUNTIME_DIR="${CFD_RUNTIME_DIR:-/workspace/.cfd}"
export CFD_OPENFOAM_DIR="${CFD_OPENFOAM_DIR:-$CFD_RUNTIME_DIR/openfoam}"

if [ -x "$CFD_OPENFOAM_DIR/usr/bin/simpleFoam" ]; then
  source "$cfd_script_dir/openfoam-env.sh"
  if simpleFoam -help >/dev/null 2>&1 && foamToVTK -help >/dev/null 2>&1; then
    printf 'OpenFOAM v1912 is ready at %s\n' "$CFD_OPENFOAM_DIR"
    exit 0
  fi
  printf 'Existing runtime is incomplete; refusing to overwrite %s. Choose a new CFD_OPENFOAM_DIR.\n' "$CFD_OPENFOAM_DIR" >&2
  exit 1
fi

if [ "$(dpkg --print-architecture)" != amd64 ] || [ "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" != debian:13 ]; then
  printf 'This helper supports Debian 13 amd64. Use a Debian 13 backend/container on other hosts.\n' >&2
  exit 1
fi

cfd_apt_dir="$CFD_RUNTIME_DIR/apt"
mkdir -p "$cfd_apt_dir/etc/apt.conf.d" "$cfd_apt_dir/etc/sources.list.d" "$cfd_apt_dir/etc/preferences.d" "$cfd_apt_dir/lists/partial" "$cfd_apt_dir/archives/partial"
cat > "$cfd_apt_dir/bootstrap.conf" <<EOF
Dir::Etc "$cfd_apt_dir/etc";
Dir::Etc::parts "apt.conf.d";
Dir::Etc::main "apt.conf";
Dir::State "$cfd_apt_dir/state";
Dir::State::lists "$cfd_apt_dir/lists";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache::archives "$cfd_apt_dir/archives";
Dir::Cache::pkgcache "$cfd_apt_dir/pkgcache.bin";
Dir::Cache::srcpkgcache "$cfd_apt_dir/srcpkgcache.bin";
Acquire::Languages "none";
EOF
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > "$cfd_apt_dir/etc/sources.list"
export APT_CONFIG="$cfd_apt_dir/bootstrap.conf"
/usr/bin/apt-get update

# APT verifies the signed Debian index and each downloaded artifact's checksum.
# Resolve any missing dependencies against the actual machine; preserve its installed packages.
cfd_packages=(openfoam=1912.200626-3+b1 libopenfoam=1912.200626-3+b1 mpi-default-bin)
cfd_plan="$(/usr/bin/apt-get --simulate --no-install-recommends install "${cfd_packages[@]}")"
# Always include core packages, even when they are also installed system-wide.
mapfile -t cfd_missing_packages < <(printf '%s\n' "$cfd_plan" | awk '/^Inst / { for (i = 3; i <= NF; i++) { if ($i ~ /^\(/) { sub(/^\(/, "", $i); print $2 "=" $i; break } } } END { print "openfoam=1912.200626-3+b1"; print "libopenfoam=1912.200626-3+b1" }' | sort -u)
(
  cd "$cfd_apt_dir/archives"
  /usr/bin/apt-get download "${cfd_missing_packages[@]}"
)

cfd_unpack_dir="$(mktemp -d "$CFD_RUNTIME_DIR/openfoam-unpack.XXXXXX")"
trap 'rm -rf -- "$cfd_unpack_dir"' EXIT
for cfd_package in "$cfd_apt_dir/archives"/*.deb; do
  cfd_package_id="$(dpkg-deb --field "$cfd_package" Package)=$(dpkg-deb --field "$cfd_package" Version)"
  for cfd_requested_package in "${cfd_missing_packages[@]}"; do
    if [ "$cfd_package_id" = "$cfd_requested_package" ]; then
      dpkg-deb --extract "$cfd_package" "$cfd_unpack_dir"
      break
    fi
  done
done
mkdir -p "$(dirname -- "$CFD_OPENFOAM_DIR")"
mv -- "$cfd_unpack_dir" "$CFD_OPENFOAM_DIR"
trap - EXIT
source "$cfd_script_dir/openfoam-env.sh"
simpleFoam -help >/dev/null
foamToVTK -help >/dev/null
# Debian's v1912 build has a SHA1 stream bug in function-object dictionary hashing.
# The application solves with -noFunctionObjects and exports fields using foamToVTK.
printf 'OpenFOAM v1912 is ready at %s\n' "$CFD_OPENFOAM_DIR"
