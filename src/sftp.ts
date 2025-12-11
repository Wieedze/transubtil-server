import { Client } from 'basic-ftp';
import path from 'path';
import { Readable } from 'stream';

export class O2SwitchStorage {
  private static instance: O2SwitchStorage | null = null;
  private client: Client;
  private connected: boolean = false;
  private connecting: Promise<void> | null = null;

  private constructor() {
    this.client = new Client();
    this.client.ftp.verbose = false; // Set to true for debugging
  }

  static getInstance(): O2SwitchStorage {
    if (!O2SwitchStorage.instance) {
      O2SwitchStorage.instance = new O2SwitchStorage();
    }
    return O2SwitchStorage.instance;
  }

  async connect() {
    if (this.connected) {
      console.log('♻️ Reusing existing FTP connection');
      return;
    }

    if (this.connecting) {
      console.log('⏳ Waiting for ongoing FTP connection...');
      await this.connecting;
      return;
    }

    this.connecting = (async () => {
      try {
        await this.client.access({
          host: process.env.O2SWITCH_SFTP_HOST!,
          port: parseInt(process.env.O2SWITCH_FTP_PORT || '21'),
          user: process.env.O2SWITCH_SFTP_USER!,
          password: process.env.O2SWITCH_SFTP_PASSWORD!,
          secure: true, // Enable FTPS (FTP over TLS)
          secureOptions: {
            rejectUnauthorized: false, // Accept self-signed certificates
          },
        });
        this.connected = true;
        console.log('✅ FTPS connection established');
      } catch (error) {
        this.connected = false;
        throw error;
      } finally {
        this.connecting = null;
      }
    })();

    await this.connecting;
  }

  async uploadFile(
    buffer: Buffer,
    filename: string,
    type: 'label-submissions' | 'studio-requests' | 'admin'
  ): Promise<string> {
    let remotePath: string;
    let publicUrl: string | null = null;

    if (type === 'admin') {
      const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
      remotePath = path.join(adminBasePath, filename);
    } else {
      remotePath = path.join(
        process.env.O2SWITCH_BASE_PATH!,
        type,
        filename
      );
      publicUrl = `${process.env.O2SWITCH_PUBLIC_URL}/${type}/${filename}`;
    }

    // Ensure directory exists
    const dir = path.dirname(remotePath);
    await this.client.ensureDir(dir);

    // Upload from buffer using a readable stream
    const readable = Readable.from(buffer);
    await this.client.uploadFrom(readable, remotePath);

    return publicUrl || remotePath;
  }

  async disconnect() {
    if (this.connected) {
      this.client.close();
      this.connected = false;
      console.log('🔌 FTP connection closed');
    }
  }

  async fileExists(filename: string, type: string): Promise<boolean> {
    try {
      const remotePath = path.join(
        process.env.O2SWITCH_BASE_PATH!,
        type,
        filename
      );
      const size = await this.client.size(remotePath);
      return size >= 0;
    } catch {
      return false;
    }
  }

  // Admin-specific methods
  async listAdminFiles(relativePath: string = '/'): Promise<any[]> {
    const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    const fullPath = path.join(adminBasePath, relativePath);

    const list = await this.client.list(fullPath);
    return list
      .filter((item) => item.name !== '.' && item.name !== '..')
      .map((item) => ({
        basename: item.name,
        filename: path.join(relativePath, item.name),
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size,
        lastmod: item.modifiedAt ? item.modifiedAt.toISOString() : new Date().toISOString(),
        mime: item.isDirectory ? undefined : 'application/octet-stream',
      }));
  }

  async downloadAdminFile(relativePath: string): Promise<Buffer> {
    const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    const fullPath = path.join(adminBasePath, relativePath);

    const chunks: Buffer[] = [];
    const writable = new (await import('stream')).Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await this.client.downloadTo(writable, fullPath);
    return Buffer.concat(chunks);
  }

  async deleteAdminFile(relativePath: string): Promise<void> {
    const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    const fullPath = path.join(adminBasePath, relativePath);

    try {
      // Try to remove as file first
      await this.client.remove(fullPath);
    } catch {
      // If it fails, try as directory
      await this.client.removeDir(fullPath);
    }
  }

  async createAdminDirectory(relativePath: string): Promise<void> {
    const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    const fullPath = path.join(adminBasePath, relativePath);

    await this.client.ensureDir(fullPath);
  }

  async searchAdminFiles(relativePath: string, query: string): Promise<any[]> {
    const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    const fullPath = path.join(adminBasePath, relativePath);

    const searchResults: any[] = [];
    const lowerQuery = query.toLowerCase();

    const searchDirectory = async (dirPath: string) => {
      const list = await this.client.list(dirPath);

      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue;

        const itemPath = path.join(dirPath, item.name);
        const relPath = itemPath.replace(adminBasePath, '').replace(/^\//, '');

        if (item.name.toLowerCase().includes(lowerQuery)) {
          searchResults.push({
            name: item.name,
            size: item.size,
            type: item.isDirectory ? 'd' : '-',
            path: relPath,
          });
        }

        if (item.isDirectory) {
          await searchDirectory(itemPath);
        }
      }
    };

    await searchDirectory(fullPath);
    return searchResults;
  }
}
