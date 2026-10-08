"""Optional authenticated OpenFOAM API for the GitHub Pages editor.

This module describes a deployment; importing it does not deploy or create secrets.
After configuring Modal securely, deploy from the repository root with:
    modal deploy deploy/modal_app.py
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import threading
import time

import modal


REPOSITORY = Path(__file__).resolve().parents[1]
PERSIST_CASES = os.environ.get("CFD_MODAL_PERSIST_CASES", "1") != "0"

app = modal.App("flow-studio-compute")
case_volume = (
    modal.Volume.from_name("flow-studio-cases", create_if_missing=True)
    if PERSIST_CASES
    else None
)

# Copy only explicit source directories and manifests. No checkout, credentials,
# node_modules, generated frontend build, or developer environment enters the image.
image = (
    modal.Image.from_registry("node:22-trixie-slim", add_python="3.12")
    .apt_install("ca-certificates", "openfoam", "openmpi-bin", "tar")
    .workdir("/app")
    .add_local_file(REPOSITORY / "package.json", "/app/package.json", copy=True)
    .add_local_file(REPOSITORY / "package-lock.json", "/app/package-lock.json", copy=True)
    .run_commands("npm ci --omit=dev")
    .add_local_dir(REPOSITORY / "server", "/app/server", copy=True, ignore=["*.test.ts"])
    .add_local_dir(REPOSITORY / "src" / "geometry", "/app/src/geometry", copy=True, ignore=["*.test.ts"])
    .env(
        {
            "CFD_OPENFOAM_DIR": "/",
            "CFD_RUNTIME_DIR": "/data/runtime",
            "CFD_RUNS_DIR": "/data/jobs",
            "CFD_API_HOST": "0.0.0.0",
            "CFD_API_PORT": "3001",
            "CFD_REQUIRE_AUTH": "1",
            # OpenMPI runs in an isolated Modal container whose default user is root.
            "OMPI_ALLOW_RUN_AS_ROOT": "1",
            "OMPI_ALLOW_RUN_AS_ROOT_CONFIRM": "1",
        }
    )
)


@app.function(
    image=image,
    cpu=4,
    memory=4096,
    timeout=86_400,
    # The API owns an in-memory job queue. Keep polling and solver processes in
    # one warm container; horizontal scaling needs a durable external job broker.
    min_containers=1,
    max_containers=1,
    volumes={"/data": case_volume} if case_volume is not None else {},
    secrets=[
        modal.Secret.from_name(
            "flow-compute",
            required_keys=["CFD_API_TOKEN", "CFD_ALLOWED_ORIGINS"],
        )
    ],
)
@modal.concurrent(max_inputs=32)
@modal.web_server(3001, startup_timeout=120)
def compute_api() -> None:
    """Start the existing Node API. Fail closed if remote credentials are absent."""
    if not os.environ.get("CFD_API_TOKEN", "").strip():
        raise RuntimeError("Modal Secret flow-compute must provide CFD_API_TOKEN.")
    if not os.environ.get("CFD_ALLOWED_ORIGINS", "").strip():
        raise RuntimeError("Modal Secret flow-compute must provide CFD_ALLOWED_ORIGINS.")
    Path("/data/jobs").mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        ["/app/node_modules/.bin/tsx", "/app/server/index.ts"],
        cwd="/app",
        env=os.environ.copy(),
    )

    if case_volume is not None:
        # The Node process writes files after this function returns. Commit from
        # its parent container periodically; this is artifact retention, not job recovery.
        def commit_cases() -> None:
            while process.poll() is None:
                time.sleep(30)
                try:
                    case_volume.commit()
                except Exception as error:
                    print(f"Case-volume commit failed ({type(error).__name__}).", flush=True)

        threading.Thread(target=commit_cases, name="case-volume-commits", daemon=True).start()
