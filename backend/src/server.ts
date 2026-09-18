import express, { Request, Response } from 'express';
import fs, { existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path, { join } from 'path';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const BACKUP_DISK = process.env.BACKUP_DISK || '/run/media/amitp/Backup';

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
      if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
        // Backup: /run/media/amitp/Backup/{config}/
        configPath = path.join(queryPath, config);
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
        if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
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
          const infoXmlPath = path.join(snapshotPath, 'info.xml');
          let date = 'unknown';
          
          try {
            let xmlContent = '';
            if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
              xmlContent = fs.readFileSync(infoXmlPath, 'utf8');
            } else {
              xmlContent = execFileSync('sudo', ['cat', '--', infoXmlPath], { encoding: 'utf8' });
            }
            const dateMatch = xmlContent.match(/<date>([^<]+)<\/date>/);
            if (dateMatch) date = dateMatch[1].split('T')[0];
          } catch (e) {}
          
          if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
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
    const snapPath = path.join(BACKUP_DISK, config, id);
    const infoXmlPath = path.join(BACKUP_DISK, config, `${id}.info.xml`);
    
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

function isBackupPath(queryPath: string): boolean {
  return queryPath === BACKUP_DISK || queryPath.includes('Backup');
}

function snapshotBasePath(queryPath: string, config: string, id: string): string {
  if (isBackupPath(queryPath)) return path.join(queryPath, config, id);
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





// List available configs
app.get('/api/configs', (req: Request, res: Response) => {
  try {
    const queryPath = req.query.path as string || '/';
    const configs: any[] = [];
    
    // List snapshot configs (root, home, src)
    const backupPath = queryPath === '/' || queryPath === '' ? '/run/media/amitp/Backup' : queryPath;
    const validConfigs = ['root', 'home', 'src'];
    for (const config of validConfigs) {
      const configPath = join(backupPath, config);
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
