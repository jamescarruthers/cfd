import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ValidatedInput, Vec3 } from './input'

function header(object: string, className = 'dictionary'): string {
  return `FoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${className};\n    object ${object};\n}\n`
}
const tuple = (value: readonly number[]) => `(${value.join(' ')})`

export function caseFiles(input: ValidatedInput): Record<string, string> {
  const { settings, locationInMesh, triangleCount } = input
  const { min, max } = settings.domain
  const isChannel = settings.boundary === 'channel'
  const turbulence = settings.turbulence ?? 'kOmegaSST'
  const velocity = settings.velocity
  const k = Math.max(1e-8, 1.5 * (0.05 * velocity) ** 2)
  const length = Math.min(...max.map((n, i) => n - min[i]))
  const omega = Math.max(1e-5, Math.sqrt(k) / (0.09 ** 0.25 * 0.07 * length))
  const vertices: Vec3[] = [
    [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
  ]
  const sides = ['bottom', 'top', 'front', 'back']
  const sideFaces = ['(0 1 5 4)', '(3 7 6 2)', '(0 3 2 1)', '(4 5 6 7)']
  const sideType = isChannel ? 'wall' : 'symmetryPlane'
  const surfaceBoundary = (body: string) => triangleCount ? `solid\n{ ${body} }\n` : ''
  const sideBoundary = (body: string) => sides.map((name) => `${name}\n{ ${body} }`).join('\n')
  const field = (name: string, dimensions: string, value: string, inlet: string, outlet: string, solid: string, channelWall: string) =>
    `${header(name, name === 'U' ? 'volVectorField' : 'volScalarField')}dimensions ${dimensions};\ninternalField uniform ${value};\nboundaryField\n{\ninlet { ${inlet} }\noutlet { ${outlet} }\n${sideBoundary(isChannel ? channelWall : 'type symmetryPlane;')}\n${surfaceBoundary(solid)} }\n`
  const files: Record<string, string> = {
    'system/blockMeshDict': `${header('blockMeshDict')}convertToMeters 1;\nvertices\n(\n${vertices.map(tuple).join('\n')}\n);\nblocks (hex (0 1 2 3 4 5 6 7) ${tuple(settings.cells)} simpleGrading (1 1 1));\nedges ();\nboundary\n(\ninlet {type patch; faces ((0 4 7 3));}\noutlet {type patch; faces ((1 2 6 5));}\n${sides.map((name, i) => `${name} {type ${sideType}; faces (${sideFaces[i]});}`).join('\n')}\n);\nmergePatchPairs ();\n`,
    'system/controlDict': `${header('controlDict')}application simpleFoam;\nstartFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime ${settings.iterations};\ndeltaT 1;\nwriteControl timeStep;\nwriteInterval ${Math.min(20, settings.iterations)};\npurgeWrite 2;\nwriteFormat ascii;\nwritePrecision 9;\nwriteCompression off;\ntimeFormat general;\ntimePrecision 6;\nrunTimeModifiable false;\n`,
    'system/fvSchemes': `${header('fvSchemes')}ddtSchemes { default steadyState; }\ngradSchemes { default Gauss linear; }\ndivSchemes\n{\ndefault none;\ndiv(phi,U) bounded Gauss linearUpwind grad(U);\ndiv(phi,k) bounded Gauss upwind;\ndiv(phi,omega) bounded Gauss upwind;\ndiv((nuEff*dev2(T(grad(U))))) Gauss linear;\n}\nlaplacianSchemes { default Gauss linear limited 0.5; }\ninterpolationSchemes { default linear; }\nsnGradSchemes { default limited 0.5; }\nwallDist { method meshWave; }\n`,
    'system/fvSolution': `${header('fvSolution')}solvers\n{\np {solver GAMG; tolerance 1e-8; relTol 0.05; smoother GaussSeidel;}\n"(U|k|omega)" {solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0.05;}\n}\nSIMPLE\n{\nnNonOrthogonalCorrectors 1;\nconsistent yes;\nresidualControl {p 1e-4; U 1e-5; "(k|omega)" 1e-5;}\n}\nrelaxationFactors\n{fields {p 0.3;} equations {U 0.7; k 0.7; omega 0.7;}}\n`,
    'system/decomposeParDict': `${header('decomposeParDict')}numberOfSubdomains ${settings.cores};\nmethod hierarchical;\nhierarchicalCoeffs {n (${settings.cores} 1 1); delta 0.001; order xyz;}\n`,
    'constant/transportProperties': `${header('transportProperties')}transportModel Newtonian;\nnu [0 2 -1 0 0 0 0] ${settings.viscosity};\n`,
    'constant/turbulenceProperties': `${header('turbulenceProperties')}simulationType ${turbulence === 'laminar' ? 'laminar' : 'RAS'};\n${turbulence === 'laminar' ? '' : 'RAS {RASModel kOmegaSST; turbulence on; printCoeffs on;}'}\n`,
    '0/U': field('U', '[0 1 -1 0 0 0 0]', `(${velocity} 0 0)`, `type fixedValue; value uniform (${velocity} 0 0);`, 'type zeroGradient;', 'type noSlip;', 'type noSlip;'),
    '0/p': field('p', '[0 2 -2 0 0 0 0]', '0', 'type zeroGradient;', 'type fixedValue; value uniform 0;', 'type zeroGradient;', 'type zeroGradient;'),
    '0/k': field('k', '[0 2 -2 0 0 0 0]', String(k), `type fixedValue; value uniform ${k};`, `type inletOutlet; inletValue uniform ${k}; value uniform ${k};`, `type kqRWallFunction; value uniform ${k};`, `type kqRWallFunction; value uniform ${k};`),
    '0/omega': field('omega', '[0 0 -1 0 0 0 0]', String(omega), `type fixedValue; value uniform ${omega};`, `type inletOutlet; inletValue uniform ${omega}; value uniform ${omega};`, `type omegaWallFunction; value uniform ${omega};`, `type omegaWallFunction; value uniform ${omega};`),
    '0/nut': field('nut', '[0 2 -1 0 0 0 0]', '0', 'type calculated; value uniform 0;', 'type calculated; value uniform 0;', 'type nutkWallFunction; value uniform 0;', 'type nutkWallFunction; value uniform 0;'),
  }
  if (triangleCount) {
    files['constant/triSurface/solid.stl'] = input.scene.stl
    files['system/snappyHexMeshDict'] = `${header('snappyHexMeshDict')}castellatedMesh true;\nsnap true;\naddLayers false;\ngeometry\n{solid.stl {type triSurfaceMesh; name solid;}}\ncastellatedMeshControls\n{\nmaxLocalCells 300000;\nmaxGlobalCells 300000;\nminRefinementCells 0;\nmaxLoadUnbalance 0.1;\nnCellsBetweenLevels 3;\nfeatures ();\nrefinementSurfaces {solid {level (${input.refinementLevel} ${input.refinementLevel}); patchInfo {type wall;}}}\nresolveFeatureAngle 30;\nrefinementRegions {};\nlocationInMesh ${tuple(locationInMesh)};\nallowFreeStandingZoneFaces true;\n}\nsnapControls\n{nSmoothPatch 3; tolerance 2; nSolveIter 30; nRelaxIter 5; nFeatureSnapIter 10; implicitFeatureSnap true; explicitFeatureSnap false; multiRegionFeatureSnap false;}\naddLayersControls\n{relativeSizes true; layers {}; expansionRatio 1; finalLayerThickness 0.3; minThickness 0.1; nGrow 0; featureAngle 60; slipFeatureAngle 30; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedialAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50;}\nmeshQualityControls\n{maxNonOrtho 65; maxBoundarySkewness 20; maxInternalSkewness 4; maxConcave 80; minVol 1e-13; minTetQuality 1e-15; minArea -1; minTwist 0.02; minDeterminant 0.001; minFaceWeight 0.02; minVolRatio 0.01; minTriangleTwist -1; nSmoothScale 4; errorReduction 0.75; relaxed {maxNonOrtho 75;}}\nmergeTolerance 1e-6;\n`
  }
  return files
}

export async function writeCase(directory: string, input: ValidatedInput): Promise<void> {
  for (const [relativePath, content] of Object.entries(caseFiles(input))) {
    const filePath = path.join(directory, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
  }
  await writeFile(path.join(directory, 'flow-studio-input.json'), JSON.stringify({ settings: input.settings, triangleCount: input.triangleCount, refinementLevel: input.refinementLevel, minimumWall: input.minimumWall }, null, 2))
}
