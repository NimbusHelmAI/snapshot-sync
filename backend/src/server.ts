import express, { Request, Response } from 'express';
import fs, { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path, { join } from 'path';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const BACKUP_DISK = process.env.BACKUP_DISK || '/run/media/amitp/Backup';

/**
 * Synced snapshots live under <disk>/snapshots/<config>/<id>, with snapper's
 * metadata alongside each one as <id>.info.xml.
 *
 * The namespace exists because the backup disk also holds unrelated
 * directories at its root — <disk>/src, for one, contains a flat copy of the
 * source tree that the sync script never wrote. Keeping synced snapshots in
 * their own subtree stops the two being confused for each other.
 */
const BACKUP_SUBDIR = 'snapshots';

/** True when a requested path refers to the external backup disk. */
function isBackupPath(queryPath: string): boolean {
  return queryPath === BACKUP_DISK || queryPath.includes('Backup');
}

/** Directory holding one config's synced snapshots on a backup disk. */
function backupConfigDir(diskRoot: string, config: string): string {
  return path.join(diskRoot, BACKUP_SUBDIR, config);
}

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// List snapshots - only root and home for now
app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const queryPath = req.query.path as string || BACKUP_DISK;
    const configs: Record<string, any[]> = {};
    const validConfigs = ['root', 'home', 'src'];
    
    validConfigs.forEach(config => {
      let configPath: string;
      
      // Determine snapshot path based on query
      if (isBackupPath(queryPath)) {
        // Backup: <disk>/snapshots/<config>/
        configPath = backupConfigDir(queryPath, config);
      } else {
        // Local paths
        if (config === 'root') {
          configPath = '/.snapshots';
        } else if (config === 'src') {
          configPath = '/home/amitp/src/.snapshots';
        } else {
          configPath = path.join('/', config, '.snapshots');
        }
      }
      
      const snapshots: any[] = [];
      let entries: string[] = [];
      
      try {
        if (isBackupPath(queryPath)) {
          // Backup path: normal read
          if (!fs.existsSync(configPath)) return;
          entries = fs.readdirSync(configPath);
        } else {
          // Local path: always use sudo
          const output = execFileSync('sudo', ['ls', '--', configPath], { encoding: 'utf8' });
          entries = output.trim().split('\n').filter(e => e.length > 0);
        }
      } catch (e) {
        return;
      }
      
      entries.forEach(entry => {
        if (!/^\d+$/.test(entry)) return; // Skip non-numeric
        
        try {
          const snapshotPath = path.join(configPath, entry);
          // snapper keeps info.xml inside the snapshot directory; the sync
          // script writes it beside the received subvolume instead, because
          // btrfs send/receive does not carry snapper's metadata across.
          const infoXmlPath = isBackupPath(queryPath)
            ? path.join(configPath, `${entry}.info.xml`)
            : path.join(snapshotPath, 'info.xml');
          let date = 'unknown';
          
          try {
            let xmlContent = '';
            if (isBackupPath(queryPath)) {
              xmlContent = fs.readFileSync(infoXmlPath, 'utf8');
            } else {
              xmlContent = execFileSync('sudo', ['cat', '--', infoXmlPath], { encoding: 'utf8' });
            }
            const dateMatch = xmlContent.match(/<date>([^<]+)<\/date>/);
            if (dateMatch) date = dateMatch[1].split('T')[0];
          } catch (e) {}
          
          if (isBackupPath(queryPath)) {
            const stat = fs.statSync(snapshotPath);
            if (stat.isDirectory()) {
              snapshots.push({ id: entry, date });
            }
          } else {
            snapshots.push({ id: entry, date });
          }
        } catch (e) {}
      });
      
      if (snapshots.length > 0) {
        configs[config] = snapshots.sort((a, b) => parseInt(b.id) - parseInt(a.id));
      }
    });
    
    res.json({ path: queryPath, configs });
  } catch (error) {
    const err = error as Error;
    console.error('Error in /api/snapshots:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get snapshot details
app.get('/api/snapshots/:config/:id', (req: Request, res: Response) => {
  try {
    const { config, id } = req.params as { config: string; id: string };

    // Same guard the browse and file endpoints use. Without it, a config of
    // "../../etc" walks straight out of the backup disk via path.join.
    if (!SAFE_SEGMENT.test(config) || !SAFE_SEGMENT.test(id)) {
      return res.status(400).json({ error: 'invalid config or snapshot id' });
    }

    const configDir = backupConfigDir(BACKUP_DISK, config);
    const snapPath = path.join(configDir, id);
    const infoXmlPath = path.join(configDir, `${id}.info.xml`);

    if (!fs.existsSync(snapPath) || !fs.existsSync(infoXmlPath)) {
      return res.status(404).json({ error: 'snapshot not found' });
    }
    
    const details: any = {
      config,
      id,
      path: snapPath,
    };
    
    // Read metadata from info.xml
    try {
      const xml = fs.readFileSync(infoXmlPath, 'utf8');
      const dateMatch = xml.match(/<date>(.*?)<\/date>/);
      const descMatch = xml.match(/<description>(.*?)<\/description>/);
      if (dateMatch) details.date = dateMatch[1];
      if (descMatch) details.description = descMatch[1];
    } catch (e) {}
    
    res.json(details);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Browse snapshot filesystem
// ---------------------------------------------------------------------------

type BrowseItemType = 'directory' | 'file' | 'symlink' | 'other';

interface BrowseItem {
  name: string;
  type: BrowseItemType;
  owner: string;
  group: string;
  size: number;
  modified: string;
  permissions: string;
  target?: string;
}

/**
 * Matches one entry of `ls -lA --time-style=long-iso`:
 *   drwxr-xr-x 2 root root 4096 2026-09-17 21:19 name
 * Groups: permissions, owner, group, size, date, time, name.
 * Device nodes print "major, minor" where the size goes and so do not match;
 * they are skipped rather than reported with a bogus size.
 */
const LS_ENTRY =
  /^(\S+)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;

function typeFromPermissions(permissions: string): BrowseItemType {
  switch (permissions[0]) {
    case 'd':
      return 'directory';
    case 'l':
      return 'symlink';
    case '-':
      return 'file';
    default:
      return 'other';
  }
}

function parseLsOutput(output: string): BrowseItem[] {
  const items: BrowseItem[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('total ')) continue;

    const match = LS_ENTRY.exec(trimmed);
    if (!match) continue;

    const [, permissions, owner, group, size, date, time, rawName] = match;
    const type = typeFromPermissions(permissions);

    let name = rawName;
    let target: string | undefined;

    if (type === 'symlink') {
      const arrow = rawName.indexOf(' -> ');
      if (arrow !== -1) {
        name = rawName.slice(0, arrow);
        target = rawName.slice(arrow + 4);
      }
    }

    items.push({
      name,
      type,
      owner,
      group,
      size: Number(size),
      modified: `${date}T${time}:00`,
      permissions: permissions.slice(1, 10),
      ...(target !== undefined ? { target } : {}),
    });
  }

  return items;
}

/**
 * Lists a directory with `ls -lA`, under sudo for root-owned snapshot trees.
 * Arguments are passed as an array rather than a shell string, so a crafted
 * path cannot break out into a shell command. `--` stops a path that begins
 * with a dash being read as an option.
 */
function listDirectory(targetPath: string, useSudo: boolean): BrowseItem[] {
  const lsArgs = ['-lA', '--time-style=long-iso', '--', targetPath];

  const output = useSudo
    ? execFileSync('sudo', ['ls', ...lsArgs], { encoding: 'utf8', timeout: 15_000 })
    : execFileSync('ls', lsArgs, { encoding: 'utf8', timeout: 15_000 });

  return parseLsOutput(output);
}

/**
 * Resolves a caller-supplied subPath against the snapshot root. Returns null
 * if it escapes that root (via `..`, an absolute path, or a NUL byte).
 */
function resolveSubPath(basePath: string, subPath: string): string | null {
  const resolvedBase = path.resolve(basePath);
  if (!subPath) return resolvedBase;
  if (subPath.includes('\0')) return null;

  const resolved = path.resolve(resolvedBase, subPath);
  const escapes =
    resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep);

  return escapes ? null : resolved;
}

function snapshotBasePath(queryPath: string, config: string, id: string): string {
  if (isBackupPath(queryPath)) return path.join(backupConfigDir(queryPath, config), id);
  if (config === 'root') return path.join('/.snapshots', id);
  if (config === 'src') return path.join('/home/amitp/src/.snapshots', id);
  return path.join('/', config, '.snapshots', id);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

app.get('/api/snapshots/:config/:id/browse', (req: Request, res: Response) => {
  const { config, id } = req.params as { config: string; id: string };

  // Both land in a filesystem path, so constrain them to safe segments.
  if (!SAFE_SEGMENT.test(config) || !SAFE_SEGMENT.test(id)) {
    return res.status(400).json({ error: 'Invalid config or snapshot id' });
  }

  const queryPath = (req.query.path as string) || BACKUP_DISK;
  const subPath = (req.query.subPath as string) || '';

  const basePath = snapshotBasePath(queryPath, config, id);
  const targetPath = resolveSubPath(basePath, subPath);

  if (targetPath === null) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const items = listDirectory(targetPath, !isBackupPath(queryPath));

    items.sort((a, b) => {
      const aDir = a.type === 'directory';
      const bDir = b.type === 'directory';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = subPath ? path.posix.dirname(subPath) : null;

    res.json({
      items,
      currentPath: subPath,
      parentPath: parent === '.' ? '' : parent,
    });
  } catch (error) {
    const err = error as Error;
    console.error(`Browse failed for ${targetPath}:`, err.message);

    if (/No such file or directory/i.test(err.message)) {
      return res.status(404).json({ error: 'Path not found' });
    }
    if (/Permission denied|not allowed/i.test(err.message)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    res.status(500).json({ error: 'Browse failed' });
  }
});


// ---------------------------------------------------------------------------
// Read one file inside a snapshot, for preview
// ---------------------------------------------------------------------------

/** Text is capped lower than images: it all has to fit on screen anyway. */
const MAX_TEXT_BYTES = 1024 * 1024; // 1 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const READ_CAP = MAX_IMAGE_BYTES;

/**
 * Image formats recognised by magic bytes rather than by extension, so a
 * mislabelled file is still classified correctly. SVG is deliberately absent:
 * it is XML, so it is served down the text path instead of being handed to an
 * <img> tag.
 */
const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a' },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.test(buffer)) return sig.mime;
  }
  return null;
}

/**
 * Treats a buffer as text if its first 8 KiB carry no NUL byte and decode as
 * valid UTF-8. This catches source, config and log files regardless of
 * extension, and rejects binaries without needing a format list.
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  if (sample.includes(0)) return false;

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  return !decoded.includes('�');
}

function readFileCapped(targetPath: string, useSudo: boolean): Buffer {
  if (useSudo) {
    return execFileSync('sudo', ['cat', '--', targetPath], {
      maxBuffer: READ_CAP + 1024,
      timeout: 15_000,
    });
  }

  // Readable directly: check the size before pulling it into memory, so a
  // huge file is refused rather than buffered.
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    const err: NodeJS.ErrnoException = new Error('Is a directory');
    err.code = 'EISDIR';
    throw err;
  }
  if (stat.size > READ_CAP) {
    const err: NodeJS.ErrnoException = new Error('File exceeds preview limit');
    err.code = 'ENOBUFS';
    throw err;
  }
  return fs.readFileSync(targetPath);
}

app.get('/api/snapshots/:config/:id/file', (req: Request, res: Response) => {
  const { config, id } = req.params as { config: string; id: string };

  if (!SAFE_SEGMENT.test(config) || !SAFE_SEGMENT.test(id)) {
    return res.status(400).json({ error: 'Invalid config or snapshot id' });
  }

  const queryPath = (req.query.path as string) || BACKUP_DISK;
  const subPath = (req.query.subPath as string) || '';

  if (!subPath) {
    return res.status(400).json({ error: 'subPath is required' });
  }

  const basePath = snapshotBasePath(queryPath, config, id);
  const targetPath = resolveSubPath(basePath, subPath);

  if (targetPath === null) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const name = path.posix.basename(subPath);

  try {
    const buffer = readFileCapped(targetPath, !isBackupPath(queryPath));

    const imageMime = detectImageMime(buffer);
    if (imageMime) {
      if (buffer.length > MAX_IMAGE_BYTES) {
        return res.json({
          kind: 'unsupported',
          name,
          reason: `Image is ${formatBytes(buffer.length)}; preview is limited to ${formatBytes(MAX_IMAGE_BYTES)}.`,
        });
      }
      return res.json({
        kind: 'image',
        name,
        mimeType: imageMime,
        dataUrl: `data:${imageMime};base64,${buffer.toString('base64')}`,
        size: buffer.length,
      });
    }

    if (looksLikeText(buffer)) {
      const truncated = buffer.length > MAX_TEXT_BYTES;
      return res.json({
        kind: 'text',
        name,
        content: buffer.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
        truncated,
        size: buffer.length,
      });
    }

    return res.json({
      kind: 'unsupported',
      name,
      reason: 'This file is not text or a supported image format, so it cannot be displayed.',
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { message: string };
    console.error(`File read failed for ${targetPath}:`, err.message);

    if (err.code === 'ENOBUFS' || /maxBuffer/i.test(err.message)) {
      return res.json({
        kind: 'unsupported',
        name,
        reason: `File is larger than the ${formatBytes(READ_CAP)} preview limit.`,
      });
    }
    if (/No such file or directory/i.test(err.message) || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    if (/Permission denied|not allowed|a password is required/i.test(err.message) || err.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    if (/Is a directory/i.test(err.message) || err.code === 'EISDIR') {
      return res.status(400).json({ error: 'Not a file' });
    }
    res.status(500).json({ error: 'Could not read file' });
  }
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}




// List available configs
app.get('/api/configs', (req: Request, res: Response) => {
  try {
    const queryPath = req.query.path as string || '/';
    const configs: any[] = [];
    
    // List snapshot configs (root, home, src)
    const backupPath = queryPath === '/' || queryPath === '' ? BACKUP_DISK : queryPath;
    const validConfigs = ['root', 'home', 'src'];
    for (const config of validConfigs) {
      const configPath = backupConfigDir(backupPath, config);
      if (existsSync(configPath)) {
        const snapshots = readdirSync(configPath).filter((f: string) => !f.endsWith('.info.xml'));
        configs.push({ name: config, path: config, snapshotCount: snapshots.length });
      }
    }

    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list configs' });
  }
});

app.listen(PORT, () => {
  console.log(`Snapshot Sync API running on port ${PORT}`);
  console.log(`Backup disk: ${BACKUP_DISK}`);
  console.log('Configs enabled: root, home, src');
});

export default app;
