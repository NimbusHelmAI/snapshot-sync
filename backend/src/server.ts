import express, { Request, Response } from 'express';
import fs, { existsSync, readdirSync } from 'fs';
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
    const configs: Record<string, any[]> = {};
    // Temporarily disabled 'src' until sync script is fixed
    const validConfigs = ['root', 'home', 'src'];
    
    validConfigs.forEach(config => {
      const configPath = path.join(BACKUP_DISK, config);
      if (!fs.existsSync(configPath)) {
        return;
      }
      
      const snapshots: any[] = [];
      const entries = fs.readdirSync(configPath);
      
      entries.forEach(entry => {
        const entryPath = path.join(configPath, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory() && /^\d+$/.test(entry)) {
            // Only include if .info.xml exists (valid snapshot)
            const infoXmlPath = path.join(configPath, `${entry}.info.xml`);
            if (fs.existsSync(infoXmlPath)) {
              snapshots.push({ id: entry });
            }
          }
        } catch (e) {}
      });
      
      if (snapshots.length > 0) {
        configs[config] = snapshots.sort((a, b) => parseInt(b.id) - parseInt(a.id));
      }
    });
    
    res.json({ backup_disk: BACKUP_DISK, configs });
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
    const subPath = req.query.path as string || '';
    const basePath = path.join(BACKUP_DISK, config, id);
    const targetPath = subPath ? path.join(basePath, subPath) : basePath;
    
    if (!targetPath.startsWith(basePath)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }
    
    const items: any[] = [];
    const files = fs.readdirSync(targetPath);
    
    for (const file of files) {
      try {
        const fullPath = path.join(targetPath, file);
        const stat = fs.statSync(fullPath);
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
