import SftpClient from 'ssh2-sftp-client';
import path from 'path';

export class O2SwitchStorage {
    constructor() {
        this.connected = false;
        this.connecting = null;
        this.client = new SftpClient();
    }

    static getInstance() {
        if (!O2SwitchStorage.instance) {
            O2SwitchStorage.instance = new O2SwitchStorage();
        }
        return O2SwitchStorage.instance;
    }

    async connect() {
        if (this.connected) {
            console.log('♻️ Reusing existing SFTP connection');
            return;
        }
        if (this.connecting) {
            console.log('⏳ Waiting for ongoing SFTP connection...');
            await this.connecting;
            return;
        }
        this.connecting = (async () => {
            try {
                await this.client.connect({
                    host: process.env.O2SWITCH_SFTP_HOST,
                    port: parseInt(process.env.O2SWITCH_SFTP_PORT || '22'),
                    username: process.env.O2SWITCH_SFTP_USER,
                    password: process.env.O2SWITCH_SFTP_PASSWORD,
                    readyTimeout: 60000,
                    retries: 3,
                    retry_factor: 2,
                    retry_minTimeout: 2000,
                    keepaliveInterval: 10000,
                    keepaliveCountMax: 3,
                });
                this.connected = true;
                console.log('✅ SFTP connection established');
            }
            catch (error) {
                this.connected = false;
                throw error;
            }
            finally {
                this.connecting = null;
            }
        })();
        await this.connecting;
    }

    async uploadFile(buffer, filename, type) {
        let remotePath;
        let publicUrl = null;
        if (type === 'admin') {
            const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
            remotePath = path.join(adminBasePath, filename);
        }
        else {
            remotePath = path.join(process.env.O2SWITCH_BASE_PATH, type, filename);
            publicUrl = `${process.env.O2SWITCH_PUBLIC_URL}/${type}/${filename}`;
        }
        await this.client.put(buffer, remotePath);
        return publicUrl || remotePath;
    }

    async disconnect() {
        if (this.connected) {
            await this.client.end();
            this.connected = false;
            console.log('🔌 SFTP connection closed');
        }
    }

    async fileExists(filename, type) {
        try {
            const remotePath = path.join(process.env.O2SWITCH_BASE_PATH, type, filename);
            return await this.client.exists(remotePath) !== false;
        }
        catch {
            return false;
        }
    }

    // Admin-specific methods
    async listAdminFiles(relativePath = '/') {
        const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
        const fullPath = path.join(adminBasePath, relativePath);
        const list = await this.client.list(fullPath);
        return list
            .filter((item) => item.name !== '.' && item.name !== '..')
            .map((item) => ({
                basename: item.name,
                filename: path.join(relativePath, item.name),
                type: item.type === 'd' ? 'directory' : 'file',
                size: item.size,
                lastmod: new Date(item.modifyTime).toISOString(),
                mime: item.type === 'd' ? undefined : 'application/octet-stream',
            }));
    }

    async downloadAdminFile(relativePath) {
        const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
        const fullPath = path.join(adminBasePath, relativePath);
        return await this.client.get(fullPath);
    }

    async deleteAdminFile(relativePath) {
        const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
        const fullPath = path.join(adminBasePath, relativePath);
        const stat = await this.client.stat(fullPath);
        if (stat.isDirectory) {
            await this.client.rmdir(fullPath, true);
        } else {
            await this.client.delete(fullPath);
        }
    }

    async createAdminDirectory(relativePath) {
        const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
        const fullPath = path.join(adminBasePath, relativePath);
        await this.client.mkdir(fullPath, true);
    }

    async searchAdminFiles(relativePath, query) {
        const adminBasePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
        const fullPath = path.join(adminBasePath, relativePath);
        const searchResults = [];
        const lowerQuery = query.toLowerCase();

        const searchDirectory = async (dirPath) => {
            const list = await this.client.list(dirPath);
            for (const item of list) {
                if (item.name === '.' || item.name === '..')
                    continue;
                const itemPath = path.join(dirPath, item.name);
                const relPath = itemPath.replace(adminBasePath, '').replace(/^\//, '');
                if (item.name.toLowerCase().includes(lowerQuery)) {
                    searchResults.push({
                        name: item.name,
                        size: item.size,
                        type: item.type === 'd' ? 'd' : '-',
                        path: relPath,
                    });
                }
                if (item.type === 'd') {
                    await searchDirectory(itemPath);
                }
            }
        };

        await searchDirectory(fullPath);
        return searchResults;
    }
}

O2SwitchStorage.instance = null;
