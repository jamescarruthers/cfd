# Flow — Airflow Studio

A browser workspace for building geometry and running **real 3D OpenFOAM CFD**. Hollow pipes, elbows and connected T unions, solid primitives, watertight STL/OBJ import, SI boundary controls, volumetric meshing, parallel solver jobs and results visualization.

The browser uses **WebGPU for rendering** when available, with a WebGL2 fallback. **OpenFOAM performs the numerical solve on Linux using multiple MPI CPU processes.** GPU physics and Rust/native execution are not implemented. This chooses an established finite-volume solver over new, unvalidated numerical code.

## Run locally

Node 22 or newer is required. The provided root-free OpenFOAM installer supports Debian 13 amd64 and installs signed, checksum-verified packages outside the checkout.

```sh
cd /workspace/cfd
npm ci --cache /workspace/.npm-cache
bash scripts/install-openfoam.sh
npm run dev
```

The launcher starts the API on port 3001 and the editor on port 5173. Open the editor in a browser. Both services are required for simulation; `npm run dev:ui` starts just the editor. For a checkout elsewhere, set `CFD_RUNTIME_DIR` and `CFD_RUNS_DIR` to writable absolute paths. The defaults are `/workspace/.cfd` and `/workspace/cfd-runs`.

1. Add a fitting or primitive, or import a **closed, consistently oriented** STL/OBJ mesh. Imported meshes retain all three dimensions and initially scale to 0.5 m along their longest dimension.
2. Select geometry to edit its position, rotation and dimensions. Save a Flow project to retain geometry and settings. Scene geometry also survives a browser reload.
3. Configure the air inlet. This version supports a **uniform velocity boundary on the X− domain face**, with a zero-gauge-pressure X+ outlet and slip side boundaries. Independently positioned internal emitters are not supported.
4. Click **Mesh & run**. Inspect mesh validation and solver residuals in the log. View velocity vectors or pressure samples and export sampled cell data as CSV.

The domain is currently fixed at 2 × 1 × 1 m. Solids must lie strictly inside it. Hollow fittings are solid material shells with open connected fluid lumens. Separate overlapping scene objects are not automatically fused into a single CAD union.

## Physics and validation

- Steady, three-dimensional incompressible RANS: `simpleFoam`, k–ω SST, no-slip solid walls, air density 1.225 kg/m³ and configurable kinematic viscosity.
- `blockMesh` and geometry-dependent `snappyHexMesh`; a failed `checkMesh` quality gate stops the job.
- Hierarchical decomposition across two or four MPI processes, reconstruction, native velocity/pressure fields and VTK case artifacts.
- Pressure is OpenFOAM kinematic pressure multiplied by air density, reported in Pa relative to the outlet reference. Results are sampled for browser display; case files contain the full fields.
- Completion and convergence are separate. The UI explicitly reports iteration-budget exhaustion. Residual convergence alone does not establish solution accuracy.

This is an **engineering CFD workflow, not a validated design rating tool**. Establish suitable boundary placement, Reynolds regime, near-wall/y+ resolution, mass conservation, residual convergence and mesh independence for each application. The default grid and iteration budget prioritize setup checks. Transient, compressible, thermal, multiphase and GPU numerical models are not included.

The Debian OpenFOAM v1912 build has a broken Scotch decomposition stub and function-object hashing bug. The backend uses hierarchical decomposition and `-noFunctionObjects`, reads native reconstructed fields, and exports with `foamToVTK` rather than depending on those broken paths.

```sh
npm run build          # Frontend and backend TypeScript, then production editor
npm test               # Geometry, project, input and security tests
npm run test:solver    # Real OpenFOAM cases and physical benchmark (runtime required)
npm run test:browser   # Chromium UI and real end-to-end solver check; npm run dev first
```

The physical benchmark checks a laminar square duct against its analytical pressure gradient, alongside uniform 3D flow, obstacle meshing, parallel execution and cancellation. These checks validate integration and selected behavior; they are not a general certification of every geometry or turbulence setup.

In this cloud machine, WebGPU compute could execute, but Three.js graphics hit a software Dawn error even in an isolated single-cube example. The app recovered to WebGL2, which passed rendered-pixel and interactive browser tests. Hardware WebGPU graphics still need validation on a supported browser and GPU. The browser test uses `/usr/bin/chromium` by default; override `CFD_CHROMIUM` for another installation.

For macOS or another host, a Linux development-container recipe is included:

```sh
docker build --platform linux/amd64 -t flow-studio .
docker run --rm -p 5173:5173 -v flow-cases:/data flow-studio
```

The Docker image has not been built in this environment. Apple Silicon runs this amd64 recipe under emulation; remote Linux compute avoids that cost.

## GitHub Pages and remote compute

`.github/workflows/pages.yml` tests, builds and deploys the static editor on pushes to `main` or a manual Actions run. In repository Settings → Pages, use **GitHub Actions** as the source. The build uses Pages’ repository base path, so the editor also works under `/cfd/`.

Pages cannot execute OpenFOAM. Use **Connect compute service** to enter an HTTPS backend origin and its bearer token. The origin is retained locally; the token remains in memory for the current tab and is never included in the static build or saved project. `VITE_API_URL` can optionally set a non-secret default origin at build time.

See [Modal deployment](deploy/README.md) for the optional cloud backend. No cloud deployment or GitHub publication is implied by a successful local build.

For a public backend, set `CFD_API_HOST=0.0.0.0`, provide `CFD_API_TOKEN` securely and set `CFD_ALLOWED_ORIGINS` to exact browser origins such as `https://jamescarruthers.github.io` (no `/cfd/` path). Public startup refuses missing authentication/origin configuration. Terminate TLS at the hosting platform. The local API binds loopback by default.

## Architecture and next steps

`src/geometry` generates and validates true 3D meshes. `src/Viewport.tsx` renders geometry and actual sampled results. `server` validates inputs, prepares reproducible OpenFOAM cases, manages cancellable jobs and extracts SI results. `scripts` installs the toolchain and launches development services.

Browser memory holds editor geometry and decimated visualization; volumetric mesh and solver memory live in the compute backend. Linux can run the solver directly, while macOS can use a Linux container or remote service. Rust and `wgpu` are sensible for a future shared native/browser GPU solver, but would require numerical benchmarks before replacing the established backend.

Future work: connected CAD assembly/Boolean operations, configurable domains and inlet patches, convergence and conservation plots, mesh studies, persistent job recovery, transient models, and a packaged native app.
