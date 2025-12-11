import SftpClient from 'ssh2-sftp-client';
import path from 'path';
export class AdminStorageClient {
    constructor() {
        this.connected = false;
        this.client = new SftpClient();
        this.basePath = process.env.ADMIN_STORAGE_PATH || '/home/faji2535/admin-files';
    }
    // Singleton pattern pour réutiliser la même connexion
    static getInstance() {
        if (!AdminStorageClient.instance) {
            AdminStorageClient.instance = new AdminStorageClient();
        }
        return AdminStorageClient.instance;
    }
    async connect() {
        // Si déjà connecté, ne pas reconnecter
        if (this.connected) {
            console.log('♻️  Reusing existing admin SFTP connection');
            return;
        }
        try {
            console.log('🔌 Connecting to o2switch SFTP for admin storage...');
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
            console.log('✅ Admin SFTP connection established');
        }
        catch (error) {
            this.connected = false;
            console.error('❌ Admin SFTP connection failed:', error);
            throw error;
        }
    }
    getFullPath(relativePath) {
        const normalized = path.normalize(relativePath);
        if (normalized.startsWith('/')) {
            return path.join(this.basePath, normalized.slice(1));
        }
        return path.join(this.basePath, normalized);
    }
    async listFiles(relativePath = '/') {
        try {
            const fullPath = this.getFullPath(relativePath);
            const list = await this.client.list(fullPath);
            return list
                .filter((item) => item.name !== '.' && item.name !== '..')
                .map((item) => ({
                name: item.name,
                type: item.type,
                size: item.size,
                modifyTime: item.modifyTime,
                accessTime: item.accessTime,
                rights: item.rights,
                owner: item.owner,
                group: item.group,
            }));
        }
        catch (error) {
            console.error('❌ Error listing files:', error);
            throw error;
        }
    }
    async uploadFile(relativePath, buffer) {
        try {
            const fullPath = this.getFullPath(relativePath);
            console.log('⬆️  Uploading file to:', fullPath);
            // Créer les dossiers parents si nécessaire
            const dirPath = path.dirname(fullPath);
            await this.client.mkdir(dirPath, true);
            await this.client.put(buffer, fullPath);
            // Récupérer les infos du fichier uploadé
            const stat = await this.client.stat(fullPath);
            return {
                name: path.basename(fullPath),
                type: stat.isDirectory ? 'directory' : 'file',
                size: stat.size,
                modifyTime: stat.modifyTime,
                accessTime: stat.accessTime,
                rights: stat.rights,
                owner: stat.owner,
                group: stat.group,
            };
        }
        catch (error) {
            console.error('❌ Error uploading file:', error);
            throw error;
        }
    }
    async downloadFile(relativePath) {
        try {
            const fullPath = this.getFullPath(relativePath);
            console.log('⬇️  Downloading file from:', fullPath);
            const buffer = await this.client.get(fullPath);
            return buffer;
        }
        catch (error) {
            console.error('❌ Error downloading file:', error);
            throw error;
        }
    }
    async deleteFile(relativePath) {
        try {
            const fullPath = this.getFullPath(relativePath);
            console.log('🗑️  Deleting:', fullPath);
            const stat = await this.client.stat(fullPath);
            if (stat.isDirectory) {
                await this.client.rmdir(fullPath, true);
            }
            else {
                await this.client.delete(fullPath);
            }
            console.log('✅ Deleted successfully');
        }
        catch (error) {
            console.error('❌ Error deleting:', error);
            throw error;
        }
    }
    async createDirectory(relativePath) {
        try {
            const fullPath = this.getFullPath(relativePath);
            console.log('📁 Creating directory:', fullPath);
            await this.client.mkdir(fullPath, true);
            const stat = await this.client.stat(fullPath);
            return {
                name: path.basename(fullPath),
                type: 'directory',
                size: stat.size,
                modifyTime: stat.modifyTime,
                accessTime: stat.accessTime,
                rights: stat.rights,
                owner: stat.owner,
                group: stat.group,
            };
        }
        catch (error) {
            console.error('❌ Error creating directory:', error);
            throw error;
        }
    }
    async moveFile(oldRelativePath, newRelativePath) {
        try {
            const oldFullPath = this.getFullPath(oldRelativePath);
            const newFullPath = this.getFullPath(newRelativePath);
            console.log('🔄 Moving from:', oldFullPath, 'to:', newFullPath);
            const newDir = path.dirname(newFullPath);
            await this.client.mkdir(newDir, true);
            await this.client.rename(oldFullPath, newFullPath);
            console.log('✅ Moved successfully');
        }
        catch (error) {
            console.error('❌ Error moving file:', error);
            throw error;
        }
    }
    async search(relativePath, query) {
        try {
            const files = await this.listFiles(relativePath);
            const lowerQuery = query.toLowerCase();
            return files.filter((file) => file.name.toLowerCase().includes(lowerQuery));
        }
        catch (error) {
            console.error('❌ Error searching files:', error);
            throw error;
        }
    }
    async getFileInfo(relativePath) {
        try {
            const fullPath = this.getFullPath(relativePath);
            const stat = await this.client.stat(fullPath);
            return {
                name: path.basename(fullPath),
                type: stat.isDirectory ? 'directory' : 'file',
                size: stat.size,
                modifyTime: stat.modifyTime,
                accessTime: stat.accessTime,
                rights: stat.rights,
                owner: stat.owner,
                group: stat.group,
            };
        }
        catch (error) {
            console.error('❌ Error getting file info:', error);
            throw error;
        }
    }
    async fileExists(relativePath) {
        try {
            const fullPath = this.getFullPath(relativePath);
            return await this.client.exists(fullPath) !== false;
        }
        catch {
            return false;
        }
    }
    async disconnect() {
        if (this.connected) {
            await this.client.end();
            this.connected = false;
            console.log('🔌 Admin SFTP connection closed');
        }
    }
}
AdminStorageClient.instance = null;
// Cleanup on process exit
process.on('exit', async () => {
    const instance = AdminStorageClient.getInstance();
    if (instance) {
        await instance.disconnect();
    }
});
process.on('SIGINT', async () => {
    const instance = AdminStorageClient.getInstance();
    if (instance) {
        await instance.disconnect();
    }
    process.exit(0);
});
