const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_FORMAT = 'rocinante-workshop-project';
const openedProjectFiles = new Set();

function projectDirectory() {
  return path.join(app.getPath('documents'), 'Rocinante Workshop Projects');
}

function isInside(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeFileName(value) {
  const slug = String(value || 'Untitled Project')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return slug || 'untitled-project';
}

function validateBundle(bundle) {
  if (!bundle || bundle.format !== PROJECT_FORMAT || !bundle.manifest || bundle.manifest.format !== 'rocinante-don') {
    throw new Error('This file is not a Rocinante Workshop project.');
  }
  if (!bundle.scenes || typeof bundle.scenes !== 'object' || !Object.keys(bundle.scenes).length) {
    throw new Error('This project does not contain any scenes.');
  }
}

async function writeProject(filePath, bundle) {
  validateBundle(bundle);
  bundle.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return { ...bundle, filePath };
}

async function loadBundleFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const raw = await fs.readFile(filePath, 'utf8');
  const contents = JSON.parse(raw);
  if (extension === '.rwp') {
    validateBundle(contents);
    openedProjectFiles.add(filePath);
    return { bundle: contents, filePath };
  }
  if (extension !== '.don' || contents.format !== 'rocinante-don') {
    throw new Error('Choose a Rocinante project (.rwp) or a .don project manifest.');
  }

  const directory = path.dirname(filePath);
  const scenes = {};
  for (const [sceneId, reference] of Object.entries(contents.scenes || {})) {
    const candidates = [String(reference), path.basename(String(reference))]
      .map(referencePath => path.resolve(directory, referencePath))
      .filter(candidate => candidate === directory || isInside(directory, candidate));
    let loaded = null;
    for (const candidate of [...new Set(candidates)]) {
      try {
        loaded = JSON.parse(await fs.readFile(candidate, 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (!loaded) {
      throw new Error(`Could not find scene file “${path.basename(String(reference))}” beside this .don file.`);
    }
    scenes[sceneId] = loaded;
  }
  if (!Object.keys(scenes).length) throw new Error('This .don manifest does not reference any scenes.');

  let behaviourCode = '';
  const behaviourReference = Object.values(contents.behaviours || {})[0];
  if (behaviourReference) {
    const candidates = [String(behaviourReference), path.basename(String(behaviourReference))]
      .map(referencePath => path.resolve(directory, referencePath))
      .filter(candidate => isInside(directory, candidate));
    for (const candidate of [...new Set(candidates)]) {
      try {
        behaviourCode = await fs.readFile(candidate, 'utf8');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  return {
    bundle: {
      format: PROJECT_FORMAT,
      version: 1,
      name: contents.game?.name || path.basename(filePath, '.don'),
      manifest: contents,
      scenes,
      behaviourCode,
      importedFrom: filePath,
      updatedAt: new Date().toISOString()
    },
    filePath: null
  };
}

ipcMain.handle('projects:list', async () => {
  const directory = projectDirectory();
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.rwp') continue;
    const filePath = path.join(directory, entry.name);
    try {
      const [bundle, stats] = await Promise.all([
        fs.readFile(filePath, 'utf8').then(JSON.parse),
        fs.stat(filePath)
      ]);
      validateBundle(bundle);
      projects.push({
        filePath,
        name: bundle.name || bundle.manifest.game?.name || path.basename(entry.name, '.rwp'),
        updatedAt: bundle.updatedAt || stats.mtime.toISOString()
      });
    } catch {
      // Ignore malformed project files and keep the launcher usable.
    }
  }
  projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return projects;
});

ipcMain.handle('projects:create', async (_event, name, bundle) => {
  const directory = projectDirectory();
  await fs.mkdir(directory, { recursive: true });
  const baseName = safeFileName(name);
  let filePath = path.join(directory, `${baseName}.rwp`);
  let suffix = 2;
  while (true) {
    try {
      await fs.access(filePath);
      filePath = path.join(directory, `${baseName}-${suffix++}.rwp`);
    } catch {
      break;
    }
  }
  openedProjectFiles.add(filePath);
  return writeProject(filePath, { ...bundle, name: String(name || 'Untitled Project').trim() });
});

ipcMain.handle('projects:save', async (_event, filePath, bundle) => {
  const resolvedPath = path.resolve(String(filePath || ''));
  const managedPath = isInside(projectDirectory(), resolvedPath);
  if (!managedPath && !openedProjectFiles.has(resolvedPath)) {
    throw new Error('This project file was not opened by Rocinante Workshop. Use Save Project to create a managed copy.');
  }
  if (path.extname(resolvedPath).toLowerCase() !== '.rwp') {
    throw new Error('Rocinante Workshop saves editable projects as .rwp files.');
  }
  return writeProject(resolvedPath, bundle);
});

ipcMain.handle('projects:load', async (_event, filePath) => {
  const resolvedPath = path.resolve(String(filePath || ''));
  if (!isInside(projectDirectory(), resolvedPath)) throw new Error('That recent project is outside the Rocinante project folder.');
  return loadBundleFile(resolvedPath);
});

ipcMain.handle('projects:delete', async (_event, filePath) => {
  const resolvedPath = path.resolve(String(filePath || ''));
  if (!isInside(projectDirectory(), resolvedPath) || path.extname(resolvedPath).toLowerCase() !== '.rwp') {
    throw new Error('Only saved .rwp projects in the Rocinante project folder can be removed here.');
  }
  await shell.trashItem(resolvedPath);
  openedProjectFiles.delete(resolvedPath);
  return { filePath: resolvedPath, removed: true };
});

ipcMain.handle('projects:open', async event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: 'Open a Rocinante project',
    properties: ['openFile'],
    filters: [{ name: 'Rocinante projects', extensions: ['rwp', 'don'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  const opened = await loadBundleFile(result.filePaths[0]);
  if (opened.filePath && !isInside(projectDirectory(), opened.filePath)) {
    const directory = projectDirectory();
    await fs.mkdir(directory, { recursive: true });
    const baseName = safeFileName(opened.bundle.name || opened.bundle.manifest.game?.name);
    let filePath = path.join(directory, `${baseName}.rwp`);
    let suffix = 2;
    while (true) {
      try {
        await fs.access(filePath);
        filePath = path.join(directory, `${baseName}-${suffix++}.rwp`);
      } catch {
        break;
      }
    }
    const saved = await writeProject(filePath, opened.bundle);
    return { bundle: saved, filePath };
  }
  return opened;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
