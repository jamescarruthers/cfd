import { describe, expect, it } from 'vitest';
import { createShape, parseObj, sceneTriangles } from './geometry';
import { DEFAULT_PROJECT_SETTINGS, validateProject, validateShapes, type FlowProject } from './project';

function project(): FlowProject {
  return { version: 1, name: 'Pipe airflow', shapes: [createShape('pipe')], settings: structuredClone(DEFAULT_PROJECT_SETTINGS) };
}

describe('saved Flow projects', () => {
  it('restores solver settings and geometry after JSON export', () => {
    const saved = project();
    saved.settings = { velocity: 4.2, viscosity: 0.000021, iterations: 400, cores: 4, cells: [48, 24, 24], domain: { min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] } };
    saved.shapes[0].rotation = [15, -30, 90];
    const restored = validateProject(JSON.parse(JSON.stringify(saved)));
    expect(restored).toEqual(saved);
  });

  it('uses independent defaults for older files with no settings', () => {
    const legacy = { version: 1, name: 'Older scene', shapes: [createShape('box')] };
    const first = validateProject(legacy), second = validateProject(legacy);
    expect(first.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
    first.settings.cells[0] = 48;
    expect(second.settings.cells[0]).toBe(32);
  });

  it('rejects malformed settings without silently reverting to defaults', () => {
    const saved = project();
    expect(() => validateProject({ ...saved, settings: null })).toThrow(/settings/);
    expect(() => validateProject({ ...saved, settings: { ...saved.settings, velocity: NaN } })).toThrow(/velocity/);
    expect(() => validateProject({ ...saved, settings: { ...saved.settings, cells: [48, 16, 16] } })).toThrow(/resolution/);
    expect(() => validateProject({ ...saved, settings: { ...saved.settings, cores: 64 } })).toThrow(/processes/);
    expect(() => validateProject({ ...saved, settings: { ...saved.settings, iterations: 20.5 } })).toThrow(/integer/);
    expect(() => validateProject({ ...saved, settings: { ...saved.settings, domain: { min: [-2, -1, -1], max: [2, 1, 1] } } })).toThrow(/fixed/);
  });

  it('rejects duplicate IDs, invalid positions, and invalid walls', () => {
    const shape = createShape('pipe');
    expect(() => validateShapes([shape, { ...shape }])).toThrow(/unique/);
    expect(() => validateShapes([{ ...shape, id: 'inlet' }])).toThrow(/reserved/);
    expect(() => validateShapes([{ ...shape, x: NaN }])).toThrow(/position/);
    expect(() => validateShapes([{ ...shape, z: 2 }])).toThrow(/position/);
    expect(() => validateShapes([{ ...shape, wall: 0.2 }])).toThrow(/thickness/);
    expect(() => validateShapes([{ ...shape, rotation: [0, Infinity, 0] }])).toThrow(/rotation/);
    expect(() => validateShapes([{ ...shape, size: 0.1 }])).toThrow(/outside diameter/);
  });

  it('rejects unsupported versions and oversized shape collections', () => {
    expect(() => validateProject({ ...project(), version: 2 })).toThrow(/supported/);
    expect(() => validateShapes(Array.from({ length: 13 }, () => createShape('box')))).toThrow(/12/);
    expect(() => validateShapes([{ ...createShape('box'), type: 'script' }])).toThrow(/unsupported/);
  });

  it('round trips a validated closed imported mesh and its scale', () => {
    const imported = { ...createShape('imported'), geometry: sceneTriangles([createShape('box')]), importedSize: 0.3, importedWidth: 0.3 };
    const saved = { ...project(), shapes: [imported] };
    const restored = validateProject(JSON.parse(JSON.stringify(saved)));
    expect(restored.shapes[0]).toEqual(imported);
    expect(restored.shapes[0].geometry).not.toBe(imported.geometry);
  });

  it.each([
    { dimensions: [0.01, 1, 1], size: 0.005, width: 0.5 },
    { dimensions: [1, 0.01, 0.01], size: 0.5, width: 0.005 },
  ])('preserves slender imported OBJ dimensions through a saved project: $dimensions', ({ dimensions, size, width }) => {
    const [x, y, z] = dimensions.map(value => value / 2);
    const vertices = [[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]];
    const obj = vertices.map(point => `v ${point.join(' ')}`).concat(['f 1 4 3 2', 'f 5 6 7 8', 'f 1 2 6 5', 'f 4 8 7 3', 'f 1 5 8 4', 'f 2 3 7 6']).join('\n');
    const [imported] = parseObj(obj);
    expect(imported.size).toBeCloseTo(size);
    expect(imported.width).toBeCloseTo(width);
    const restored = validateProject(JSON.parse(JSON.stringify({ ...project(), shapes: [imported] })));
    expect(restored.shapes[0]).toEqual(imported);
  });

  it('rejects malicious or unusable imported triangle arrays and scaling', () => {
    const imported = { ...createShape('imported'), geometry: sceneTriangles([createShape('box')]) };
    expect(() => validateShapes([{ ...imported, geometry: [NaN, ...imported.geometry.slice(1)] }])).toThrow(/coordinate/);
    expect(() => validateShapes([{ ...imported, geometry: imported.geometry.slice(9) }])).toThrow(/watertight/);
    expect(() => validateShapes([{ ...imported, geometry: Array(300_006).fill(0) }])).toThrow(/100,000/);
    expect(() => validateShapes([{ ...imported, importedSize: -1 }])).toThrow(/positive/);
    expect(() => validateShapes([{ ...imported, importedSize: 1e-300 }])).toThrow(/finite/);
    expect(() => validateShapes([{ ...imported, geometry: Array(9) }])).toThrow(/coordinate/);
  });

  it('returns only recognized data fields, leaving source objects untouched', () => {
    const saved = project();
    const source = { ...saved, executable: 'unexpected', shapes: [{ ...saved.shapes[0], html: '<script>bad()</script>' }] };
    const restored = validateProject(source);
    expect(restored).not.toHaveProperty('executable');
    expect(restored.shapes[0]).not.toHaveProperty('html');
    expect(source.shapes[0]).toHaveProperty('html');
  });
});
