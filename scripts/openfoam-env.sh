#!/usr/bin/env bash
# Source this file before using the workspace-local Debian OpenFOAM runtime.
# Override CFD_RUNTIME_DIR or CFD_OPENFOAM_DIR to choose another writable location.
export CFD_RUNTIME_DIR="${CFD_RUNTIME_DIR:-/workspace/.cfd}"
export CFD_OPENFOAM_DIR="${CFD_OPENFOAM_DIR:-$CFD_RUNTIME_DIR/openfoam}"

if [ ! -x "$CFD_OPENFOAM_DIR/usr/bin/simpleFoam" ]; then
  printf 'OpenFOAM runtime not found at %s. Run bash scripts/install-openfoam.sh first.\n' "$CFD_OPENFOAM_DIR" >&2
  return 1 2>/dev/null || exit 1
fi

export WM_PROJECT=OpenFOAM
export WM_PROJECT_VERSION=v1912
export WM_PROJECT_DIR="$CFD_OPENFOAM_DIR/usr/share/openfoam"
export WM_PROJECT_USER_DIR="$CFD_RUNTIME_DIR/openfoam-user"
export WM_MPLIB=SYSTEMOPENMPI
export WM_OPTIONS=linux64GccDPInt32Opt
export FOAM_API=1912
export FOAM_ETC="$WM_PROJECT_DIR/etc"
export FOAM_CONFIG_ETC="$FOAM_ETC"
export FOAM_APPBIN="$CFD_OPENFOAM_DIR/usr/bin"
export FOAM_LIBBIN="$CFD_OPENFOAM_DIR/usr/lib"
export FOAM_MPI=openmpi-system
export FOAM_JOB_DIR="$CFD_RUNTIME_DIR/openfoam-job-control"

case ":$PATH:" in
  *":$FOAM_APPBIN:"*) ;;
  *) export PATH="$FOAM_APPBIN:$PATH" ;;
esac
cfd_foam_libraries="$FOAM_LIBBIN/openmpi-system:$FOAM_LIBBIN:$CFD_OPENFOAM_DIR/usr/lib/x86_64-linux-gnu"
case ":${LD_LIBRARY_PATH:-}:" in
  *":$cfd_foam_libraries:"*) ;;
  *) export LD_LIBRARY_PATH="$cfd_foam_libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
esac
unset cfd_foam_libraries
