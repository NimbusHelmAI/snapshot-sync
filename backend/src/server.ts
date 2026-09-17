import express, { Request, Response } from 'express';
import fs, { existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
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
          const output = execSync(`sudo ls "${configPath}"`, { encoding: 'utf8' });
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
              xmlContent = execSync(`sudo cat "${infoXmlPath}"`, { encoding: 'utf8' });
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

// Browse snapshot filesystem
app.get('/api/snapshots/:config/:id/browse', (req: Request, res: Response) => {
  try {
    const { config, id } = req.params as { config: string; id: string };
    const queryPath = (req.query.path as string) || BACKUP_DISK;
    const subPath = req.query.subPath as string || '';
    
    let basePath: string;
    if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
      basePath = path.join(queryPath, config, id);
    } else {
      // Local paths
      if (config === 'root') {
        basePath = path.join('/.snapshots', id);
      } else if (config === 'src') {
        basePath = path.join('/home/amitp/src/.snapshots', id);
      } else {
        basePath = path.join('/', config, '.snapshots', id);
      }
    }
    const targetPath = subPath ? path.join(basePath, subPath) : basePath;
    
    if (!targetPath.startsWith(basePath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const items: any[] = [];
    let files: string[] = [];
    
    try {
      if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
        if (!fs.existsSync(targetPath)) {
          return res.status(404).json({ error: 'Path not found' });
        }
        files = fs.readdirSync(targetPath);
      } else {
        // Local path: use sudo
        const output = execSync(`sudo ls -A "${targetPath}"`, { encoding: 'utf8' });
        files = output.trim().split('\n').filter(f => f.length > 0);
      }
    } catch (e) {
      return res.status(404).json({ error: 'Path not found' });
    }
    
    for (const file of files) {
      try {
        const fullPath = path.join(targetPath, file);
        let stat;
        if (queryPath === BACKUP_DISK || queryPath.includes('Backup')) {
          stat = fs.statSync(fullPath);
        } else {
          // Local: assume directories from sudo ls
          stat = { isDirectory: () => true, size: 0, mtime: new Date(), mode: 0o755 };
        }
        items.push({
          name: file,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.isDirectory() ? 0 : stat.size,
          modified: stat.mtime,
          permissions: stat.mode.toString(8).slice(-3)
        });
      } catch (e) {}
    }
    
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    
    res.json({ items, currentPath: subPath || '' });
  } catch (error) {
    const err = error as Error;
    console.error('Browse error:', err);
    res.status(500).json({ error: err.message });
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
