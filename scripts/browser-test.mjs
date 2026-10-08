import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const baseURL = process.env.CFD_BROWSER_URL || 'http://127.0.0.1:5173';
const executablePath = process.env.CFD_CHROMIUM || '/usr/bin/chromium';
const skipSolver = process.env.CFD_SKIP_SOLVER === '1';
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

// Examine the middle of the canvas, away from DOM labels. A canvas element or
// renderer label alone does not establish that geometry was actually drawn.
function renderedPixels(png) {
  let width, height, channels;
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'Screenshot must have 8-bit samples.');
      assert.ok(data[9] === 2 || data[9] === 6, 'Screenshot must be RGB or RGBA.');
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const source = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let sum = 0, squared = 0, samples = 0, bright = 0;
  for (let y = 0, offset = 0; y < height; y++) {
    const filter = source[offset++];
    const row = Buffer.from(source.subarray(offset, offset + stride));
    offset += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      row[x] = (row[x] + prediction) & 255;
    }
    if (y > height * 0.2 && y < height * 0.8) {
      for (let x = Math.floor(width * 0.2); x < width * 0.8; x++) {
        const value = (row[x * channels] + row[x * channels + 1] + row[x * channels + 2]) / 3;
        sum += value; squared += value * value; samples++;
        if (value > 65) bright++;
      }
    }
    previous = row;
  }
  const deviation = Math.sqrt(squared / samples - (sum / samples) ** 2);
  return { bright, deviation };
}

async function createPage(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(baseURL);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A little geometry.');
  await expect(page.locator('.viewport-bottomline')).toContainText(/WebGPU|WebGL2/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Mesh & run' })).toBeEnabled({ timeout: 20_000 });
  const canvas = page.locator('[data-testid="viewport"] canvas');
  await expect.poll(async () => {
    try { return renderedPixels(await canvas.screenshot()).bright; }
    catch (error) { if (error.message.includes('not attached')) return 0; throw error; }
  }, { timeout: 20_000 }).toBeGreaterThan(100);
  const pixels = renderedPixels(await canvas.screenshot());
  assert.ok(pixels.deviation > 4, `Geometry rendering is blank (${JSON.stringify(pixels)}).`);
  console.log(`3D workspace: ${(await page.locator('.viewport-bottomline').innerText()).split('\n').at(-1)}; ${pixels.bright} rendered pixels.`);
  return { context, page, canvas, errors };
}

async function downloadJSON(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project' }).click();
  const download = await pending;
  return { download, project: JSON.parse(await readFile(await download.path(), 'utf8')) };
}

try {
  const editor = await createPage({ width: 1440, height: 1000 });
  const { page, canvas } = editor;
  await page.screenshot({ path: '/tmp/flow-desktop.png', fullPage: true });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await canvas.click({ position: { x: bounds.width - 15, y: 100 } });
  await expect(page.getByLabel('Object name', { exact: true })).toHaveCount(0);
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect(page.getByLabel('Object name', { exact: true })).toHaveValue('Main duct');
  const beforeOrbit = await canvas.screenshot();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.66, bounds.y + bounds.height * 0.58, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas.screenshot()).equals(beforeOrbit), { timeout: 5000 }).toBe(false);
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toggle grid', exact: true })).not.toHaveClass(/is-active/);
  await page.getByRole('button', { name: 'Toggle grid', exact: true }).click();
  await page.getByLabel('Object name', { exact: true }).fill('Browser check duct');
  await page.getByLabel('X', { exact: true }).fill('0.1');
  await page.getByLabel('RX', { exact: true }).fill('15');
  await page.getByLabel('Length', { exact: true }).fill('0.75');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.geometry-count')).toContainText('2 objects');
  await expect(page.getByLabel('Object name', { exact: true })).toHaveValue('Browser check duct copy');
  await page.getByRole('button', { name: 'Delete selected object', exact: true }).click();
  await expect(page.locator('.geometry-count')).toContainText('1 object');

  for (const preset of ['Straight pipe', '90° elbow', 'T-junction', 'Box', 'Sphere']) {
    await page.locator('.preset-card').filter({ has: page.locator('strong', { hasText: preset }) }).click();
    await expect(page.getByLabel('Object name', { exact: true })).toHaveValue(preset === 'T-junction' ? 'T union' : preset);
  }
  await expect(page.locator('.geometry-count')).toContainText('6 objects');
  await page.getByLabel('Diameter', { exact: true }).fill('0.42');
  await page.locator('.panel-tabs button').filter({ hasText: 'Scene' }).click();
  for (const name of ['Browser check duct', 'Straight pipe', '90° elbow', 'T union', 'Box', 'Sphere']) {
    await page.locator('.scene-list button').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).click();
    await expect(page.getByLabel('Object name', { exact: true })).toHaveValue(name);
  }
  await page.locator('.panel-tabs button').filter({ hasText: 'Geometry library' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'tetrahedron.obj', mimeType: 'text/plain',
    buffer: Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n'),
  });
  await expect(page.getByLabel('Object name', { exact: true })).toHaveValue('tetrahedron');
  await expect(page.locator('.geometry-count')).toContainText('7 objects');
  const saved = await downloadJSON(page);
  assert.equal(saved.project.version, 1);
  assert.equal(saved.project.shapes.length, 7);
  assert.equal(saved.project.shapes[0].x, 0.1);
  assert.equal(saved.project.shapes[0].rotation[0], 15);
  assert.equal(saved.project.shapes[0].size, 0.75);
  assert.equal(saved.project.shapes.at(-1).geometry.length, 36);
  await page.getByRole('button', { name: 'Configure air emitter', exact: true }).click();
  await page.getByLabel('Air speed', { exact: true }).fill('1.7');
  await expect(page.locator('.inlet-label')).toContainText('1.7 m/s');
  await page.getByRole('button', { name: 'Show solver settings', exact: true }).click();
  await page.getByLabel('Parallel CPU processes', { exact: true }).selectOption('4');
  await page.getByLabel('Base mesh resolution', { exact: true }).selectOption('24');
  await page.getByLabel('Iteration budget', { exact: true }).fill('40');
  await expect(page.locator('.study-overview')).toContainText('4 parallel CPU processes');
  await page.locator('input[type="file"]').setInputFiles({ name: saved.download.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved.project)) });
  await expect(page.locator('.geometry-count')).toContainText('7 objects');
  await expect(page.locator('.study-overview')).toContainText(`${saved.project.settings.cores} parallel CPU processes`);
  await page.getByRole('button', { name: 'Configure air emitter', exact: true }).click();
  await expect(page.getByLabel('Air speed', { exact: true })).toHaveValue(String(saved.project.settings.velocity));
  await page.reload();
  await expect(page.locator('.geometry-count')).toContainText('7 objects');
  await expect(page.getByLabel('Object name', { exact: true })).toHaveValue('Browser check duct');
  await expect(page.getByLabel('X', { exact: true })).toHaveValue('0.1');
  await expect(page.locator('.study-overview')).toContainText(`${saved.project.settings.cores} parallel CPU processes`);
  assert.deepEqual(editor.errors, [], 'Browser editor raised frontend errors.');
  console.log('Passed: camera, selection, dimensions, all primitives, duplicate/delete, watertight OBJ import, project export/import, emitter and parallel settings.');
  await editor.context.close();

  if (!skipSolver) {
    const simulation = await createPage({ width: 1440, height: 1000 });
    const page = simulation.page;
    const health = await (await page.request.get(`${baseURL}/api/health`)).json();
    assert.equal(health.ready, true);
    assert.equal(health.units.pressure, 'Pa');
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Mesh & run' }).click();
    const response = await accepted;
    assert.equal(response.status(), 202, await response.text());
    const { id } = await response.json();
    console.log(`Running actual default-pipe CFD job ${id}…`);
    const deadline = Date.now() + 120_000;
    let job;
    do {
      const response = await page.request.get(`${baseURL}/api/jobs/${id}`);
      assert.equal(response.status(), 200);
      job = await response.json();
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`Actual CFD study ${job.status}: ${job.error || ''}\n${job.logs.slice(-12000)}`);
      if (job.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert.equal(job.status, 'completed', `Actual CFD study exceeded 120 seconds: ${job.logs.slice(-5000)}`);
    await writeFile('/tmp/flow-browser-job.json', JSON.stringify(job, null, 2));
    assert.ok(job.metrics.cellCount > 0);
    assert.ok(Number.isFinite(job.metrics.maxVelocity) && job.metrics.maxVelocity > 0);
    assert.ok(job.result.pressure.length > 100);
    assert.equal(job.result.points.length, job.result.pressure.length * 3);
    assert.equal(job.result.velocity.length, job.result.points.length);
    for (const values of Object.values(job.result)) assert.ok(values.every(Number.isFinite), 'Actual solver returned nonfinite values.');
    assert.ok(job.logs.includes('simpleFoam') && job.logs.includes('snappyHexMesh'));
    await expect(page.locator('.run-summary')).toContainText('Your results are ready', { timeout: 10_000 });
    await expect(page.locator('.metrics-row')).toContainText(job.metrics.cellCount.toLocaleString('en-US'));
    await expect(page.locator('.field-legend')).toContainText('m/s');
    await page.getByRole('button', { name: 'Close solver log', exact: true }).click();
    await page.screenshot({ path: '/tmp/flow-results.png', fullPage: true });
    const velocityImage = await simulation.canvas.screenshot();
    await page.getByRole('button', { name: 'Pressure', exact: true }).click();
    await expect(page.locator('.field-legend')).toContainText('Pa');
    await expect.poll(async () => (await simulation.canvas.screenshot()).equals(velocityImage), { timeout: 5000 }).toBe(false);
    const exported = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export results', exact: true }).click();
    const csv = await readFile(await (await exported).path(), 'utf8');
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], 'x_m,y_m,z_m,u_m_s,v_m_s,w_m_s,p_Pa');
    assert.equal(lines.length, job.result.pressure.length + 1);
    assert.deepEqual(lines[1].split(',').map(Number), [...job.result.points.slice(0, 3), ...job.result.velocity.slice(0, 3), job.result.pressure[0]]);
    assert.deepEqual(simulation.errors, [], 'Solver results raised frontend errors.');
    console.log(`Passed: actual parallel CFD job ${id}, ${job.metrics.cellCount} volume cells, ${job.result.pressure.length} samples, finite SI fields, pressure visualization and matching CSV export.`);
    await simulation.context.close();
  }

  const mobile = await createPage({ width: 390, height: 844 });
  const dimensions = await mobile.page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width, `Mobile layout overflows horizontally: ${JSON.stringify(dimensions)}`);
  await mobile.page.screenshot({ path: '/tmp/flow-mobile.png', fullPage: true });
  await mobile.page.getByRole('button', { name: 'Configure air emitter', exact: true }).click();
  await mobile.page.getByLabel('Air speed', { exact: true }).fill('2.1');
  await expect(mobile.page.locator('.inlet-label')).toContainText('2.1 m/s');
  assert.deepEqual(mobile.errors, [], 'Mobile layout raised frontend errors.');
  console.log('Passed: 390 × 844 mobile layout, no horizontal overflow, emitter controls.');
  await mobile.context.close();
} finally {
  await browser.close();
}
