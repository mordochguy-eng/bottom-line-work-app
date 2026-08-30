import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import unzipper from 'unzipper';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(__dirname, '.tmp-sync');

// Never overwritten by a sync: per-machine data, local deps/build output, and
// the git metadata of whichever repo this copy happens to be checked out from.
const EXCLUDE_PREFIXES = [
  'backend/data',
  'backend/node_modules',
  'backend/.tmp-sync',
  'frontend/node_modules',
  'frontend/dist',
  '.git'
];

function isExcluded(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return EXCLUDE_PREFIXES.some(p => norm === p || norm.startsWith(p + '/'));
}

// sync-config.json lives at the project root and is checked into git, so a
// freshly-synced copy always knows where to pull the *next* update from too.
export async function getSyncConfig() {
  try {
    const raw = await fsp.readFile(path.join(APP_ROOT, 'sync-config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function downloadZip(repo, branch, destPath) {
  const url = `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`;
  const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function extractZip(zipPath, destDir) {
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });
  await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: destDir })).promise();
}

async function copyRecursive(srcDir, srcRelBase, destRoot) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const relPath = srcRelBase ? `${srcRelBase}/${entry.name}` : entry.name;
    if (isExcluded(relPath)) continue;
    const destPath = path.join(destRoot, relPath);
    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true });
      await copyRecursive(srcPath, relPath, destRoot);
    } else {
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Pulls the latest code from the public distribution repo (no git, no auth —
 * a public GitHub zip download) and overwrites the local code files in place.
 */
export async function runSync() {
  const config = await getSyncConfig();
  if (!config?.repo) {
    throw new Error('לא הוגדר ריפו לסנכרון (sync-config.json חסר בשורש הפרויקט).');
  }
  const branch = config.branch || 'main';
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, 'update.zip');
  const extractDir = path.join(TMP_DIR, 'extracted');

  await downloadZip(config.repo, branch, zipPath);
  await extractZip(zipPath, extractDir);

  const topLevelEntries = await fsp.readdir(extractDir);
  if (topLevelEntries.length !== 1) {
    throw new Error('מבנה קובץ ה-zip שהתקבל מ-GitHub אינו כצפוי.');
  }
  const sourceRoot = path.join(extractDir, topLevelEntries[0]);

  await copyRecursive(sourceRoot, '', APP_ROOT);
  await fsp.rm(TMP_DIR, { recursive: true, force: true });

  return { repo: config.repo, branch, syncedAt: new Date().toISOString() };
}

/**
 * Restarts the app after a successful sync so the new code takes effect.
 * Under PM2 (the recommended way to run this app) both processes are
 * restarted directly; otherwise this process simply exits — the .bat
 * launcher or the user restarts it manually.
 */
export function scheduleRestart(delayMs = 800) {
  setTimeout(() => {
    exec('pm2 restart bottom-line-work-backend bottom-line-work-frontend', (err) => {
      if (err) {
        console.warn('[sync] pm2 restart unavailable — exiting process; restart manually if not running under pm2.');
        process.exit(0);
      }
    });
  }, delayMs);
}
