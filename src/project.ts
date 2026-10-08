import { createShapeGeometry, validateClosedMesh, type Shape, type ShapeType } from './geometry';

export interface ProjectSettings {
  velocity: number;
  viscosity: number;
  iterations: number;
  cores: 2 | 4;
  cells: [number, number, number];
  domain: { min: [number, number, number]; max: [number, number, number] };
}

export interface FlowProject {
  version: 1;
  name: string;
  shapes: Shape[];
  settings: ProjectSettings;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  velocity: 1,
  viscosity: 0.000015,
  iterations: 100,
  cores: 2,
  cells: [32, 16, 16],
  domain: { min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] },
};

const SHAPE_TYPES = new Set<ShapeType>(['pipe', 'elbow', 'tee', 'box', 'sphere', 'imported']);
const MIN_DOMAIN = [-1, -0.5, -0.5] as const;
const MAX_DOMAIN = [1, 0.5, 0.5] as const;
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum = -Infinity, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number${Number.isFinite(minimum) && Number.isFinite(maximum) ? ` between ${minimum} and ${maximum}` : ''}.`);
  }
  return value;
}

function tuple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must contain exactly three numbers.`);
  return [finite(value[0], label), finite(value[1], label), finite(value[2], label)];
}

function text(value: unknown, label: string, maximum: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
  return value;
}

function settings(value: unknown): ProjectSettings {
  // Early scene exports did not store solver settings. Defaults apply only to
  // absent settings; a present but malformed settings object is never ignored.
  if (value === undefined) return {
    ...DEFAULT_PROJECT_SETTINGS,
    cells: [...DEFAULT_PROJECT_SETTINGS.cells],
    domain: { min: [...DEFAULT_PROJECT_SETTINGS.domain.min], max: [...DEFAULT_PROJECT_SETTINGS.domain.max] },
  };
  const source = object(value, 'Project settings');
  const velocity = finite(source.velocity, 'Inlet velocity', 0.01, 30);
  const viscosity = finite(source.viscosity, 'Kinematic viscosity', 0.000001, 0.001);
  const iterations = finite(source.iterations, 'Iteration budget', 20, 1000);
  if (!Number.isInteger(iterations)) throw new Error('Iteration budget must be an integer.');
  if (source.cores !== 2 && source.cores !== 4) throw new Error('Parallel CPU processes must be 2 or 4.');
  const cells = tuple(source.cells, 'Base mesh resolution');
  if (![24, 32, 48].includes(cells[0]) || cells[1] !== cells[0] / 2 || cells[2] !== cells[0] / 2) {
    throw new Error('Base mesh resolution must be 24 × 12 × 12, 32 × 16 × 16, or 48 × 24 × 24.');
  }
  const domain = object(source.domain, 'Simulation domain');
  const min = tuple(domain.min, 'Domain minimum'), max = tuple(domain.max, 'Domain maximum');
  if (min.some((value, i) => value !== MIN_DOMAIN[i]) || max.some((value, i) => value !== MAX_DOMAIN[i])) {
    throw new Error('This version supports the fixed 2 × 1 × 1 meter simulation domain.');
  }
  return { velocity, viscosity, iterations, cores: source.cores, cells, domain: { min, max } };
}

/** Validate and copy geometry from a project or the browser's saved scene. */
export function validateShapes(value: unknown): Shape[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('A project must contain an array of at most 12 shapes.');
  const ids = new Set<string>();
  return Array.from(value, (entry, index) => {
    const source = object(entry, `Shape ${index + 1}`);
    const id = text(source.id, 'Shape ID', 128, false);
    if (ids.has(id) || id === 'inlet') throw new Error('Shape IDs must be unique and cannot use the reserved air inlet ID.');
    ids.add(id);
    if (typeof source.type !== 'string' || !SHAPE_TYPES.has(source.type as ShapeType)) throw new Error(`Shape ${index + 1} has an unsupported geometry type.`);
    const type = source.type as ShapeType;
    const name = text(source.name, 'Shape name', 256);
    const x = finite(source.x, 'X position', MIN_DOMAIN[0], MAX_DOMAIN[0]);
    const y = finite(source.y, 'Y position', MIN_DOMAIN[1], MAX_DOMAIN[1]);
    const z = finite(source.z, 'Z position', MIN_DOMAIN[2], MAX_DOMAIN[2]);
    const rotation = tuple(source.rotation, 'Shape rotation');
    // Imported CAD can be a slender rod or a thin plate. Its true aspect ratio
    // must survive export rather than being enlarged to the primitive UI minimum.
    const minimumDimension = type === 'imported' ? 0.000001 : 0.03;
    const size = finite(source.size, 'Shape length', minimumDimension, 1.5);
    const width = finite(source.width, 'Shape width', minimumDimension, 0.7);
    const wall = finite(source.wall, 'Wall thickness');
    if (wall <= 0 || (type !== 'imported' && wall >= width / 2)) throw new Error('Wall thickness must be positive and smaller than half the shape width.');
    if (['pipe', 'elbow', 'tee'].includes(type) && size <= width) throw new Error('Pipe length or bend diameter must exceed the outside diameter.');
    const shape: Shape = { id, type, name, x, y, z, rotation, size, width, wall };
    if (type === 'imported') {
      const geometry = source.geometry;
      if (!Array.isArray(geometry) || !geometry.length || geometry.length > 300_000 || geometry.length % 9 !== 0) {
        throw new Error('Imported geometry must contain complete triangles and at most 100,000 vertices.');
      }
      shape.geometry = Array.from(geometry, value => finite(value, 'Imported vertex coordinate'));
      for (const key of ['importedSize', 'importedWidth'] as const) {
        if (!owns(source, key)) continue;
        const dimension = finite(source[key], 'Original imported dimension');
        if (dimension <= 0) throw new Error('Original imported dimensions must be positive.');
        shape[key] = dimension;
      }
      validateClosedMesh(shape.geometry);
      // Check the renderer/solver representation too: malicious scales or huge
      // coordinates can overflow Float32 or collapse otherwise finite triangles.
      const rendered = createShapeGeometry(shape);
      try {
        validateClosedMesh(Array.from(rendered.getAttribute('position').array));
      } finally { rendered.dispose(); }
    } else if (owns(source, 'geometry') || owns(source, 'importedSize') || owns(source, 'importedWidth')) {
      throw new Error('Only imported shapes may contain custom mesh data.');
    }
    return shape;
  });
}

/** All fields are validated before a caller updates application state. */
export function validateProject(value: unknown): FlowProject {
  const source = object(value, 'Project');
  if (source.version !== 1) throw new Error('This is not a supported version 1 Flow project.');
  return {
    version: 1,
    name: text(source.name, 'Project name', 80),
    shapes: validateShapes(source.shapes),
    settings: settings(source.settings),
  };
}
