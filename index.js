import express from 'express';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileTypeFromBuffer } from 'file-type';
import { createClient } from '@supabase/supabase-js';
import { O2SwitchStorage } from './sftp.js';
import adminStorageRouter from './admin-storage.js';
import shareRouter from './share-routes.js';
import catalogueRouter from './catalogue-routes.js';
dotenv.config({ path: '.env.local' });
// Initialize Supabase client for server
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
const app = express();
const PORT = process.env.PORT || 3001;
// Configuration
const MAX_DEMO_SIZE = parseInt(process.env.MAX_FILE_SIZE_DEMO || '262144000'); // 250 MB
const MAX_ACTIVE_SUBMISSIONS = parseInt(process.env.MAX_ACTIVE_SUBMISSIONS || '3');
const ALLOWED_DEMO_MIMES = ['audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff'];
// Middleware
app.use(cors({
    origin: process.env.VITE_APP_URL || 'http://localhost:5173',
    credentials: true,
}));
app.use(express.json({ limit: '10gb' })); // Support large files for admin storage
// Admin Storage routes (replaces NextCloud)
app.use('/api/nextcloud', adminStorageRouter); // Keep old route for backwards compatibility
app.use('/api/admin-storage', adminStorageRouter); // New route name
// File Sharing routes (public and admin)
app.use('/api/share', shareRouter); // Admin routes: /api/share/create, /api/share/list, etc.
app.use('/api/shared', shareRouter); // Public routes: /api/shared/:token, /api/shared/:token/download
// Catalogue management routes (artists & releases)
app.use('/api/catalogue', catalogueRouter);
// Multer configuration pour gérer les fichiers volumineux
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 500 * 1024 * 1024, // 500 MB max (pour studio requests)
    },
});
// Helper functions
async function getUserFromToken(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        return null;
    }
    return user;
}
async function checkUserDemoQuota(userId) {
    const { count, error } = await supabase
        .from('label_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['pending', 'under_review']);
    if (error)
        throw error;
    return (count || 0) < MAX_ACTIVE_SUBMISSIONS;
}
async function checkStudioAccess(userId) {
    const { data, error } = await supabase
        .from('profiles')
        .select('has_studio_access')
        .eq('id', userId)
        .single();
    if (error)
        throw error;
    return data?.has_studio_access === true;
}
function generateUniqueFilename(originalFilename) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extension = originalFilename.split('.').pop();
    return `${timestamp}_${random}.${extension}`;
}
// Routes
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        // 1. Vérifier l'authentification
        const user = await getUserFromToken(req.headers.authorization);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        // 2. Vérifier le fichier
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }
        const type = req.body.type;
        if (!type || !['label-submissions', 'studio-requests'].includes(type)) {
            return res.status(400).json({ error: 'Invalid upload type' });
        }
        const buffer = req.file.buffer;
        // 3. Validation selon le type
        if (type === 'label-submissions') {
            // Vérifier le quota
            const hasQuota = await checkUserDemoQuota(user.id);
            if (!hasQuota) {
                return res.status(403).json({
                    error: 'Upload quota exceeded. Maximum 3 active demo submissions allowed. Please wait for your pending demos to be reviewed.',
                });
            }
            // Vérifier la taille
            if (buffer.length > MAX_DEMO_SIZE) {
                return res.status(400).json({
                    error: 'File too large. Maximum size is 250 MB.',
                });
            }
            // Vérifier le type MIME
            const fileType = await fileTypeFromBuffer(buffer);
            if (!fileType || !ALLOWED_DEMO_MIMES.includes(fileType.mime)) {
                return res.status(400).json({
                    error: 'Invalid file format. Only WAV and AIFF are allowed for demos.',
                });
            }
        }
        else {
            // Studio requests
            const hasAccess = await checkStudioAccess(user.id);
            if (!hasAccess) {
                return res.status(403).json({
                    error: 'Access denied. Studio requests are only available to authorized clients.',
                });
            }
            // Vérifier que c'est un fichier audio
            const fileType = await fileTypeFromBuffer(buffer);
            if (!fileType || !fileType.mime.startsWith('audio/')) {
                return res.status(400).json({
                    error: 'Invalid file format. Only audio files are allowed.',
                });
            }
        }
        // 4. Générer un nom unique
        const uniqueFilename = generateUniqueFilename(req.file.originalname);
        console.log(`📤 Starting upload: ${uniqueFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
        // 5. Upload vers o2switch via SFTP (singleton réutilise la connexion)
        const storage = O2SwitchStorage.getInstance();
        await storage.connect();
        const fileUrl = await storage.uploadFile(buffer, uniqueFilename, type);
        console.log('✅ File uploaded successfully');
        // 6. Retourner l'URL
        res.json({
            success: true,
            url: fileUrl,
            filename: uniqueFilename,
        });
    }
    catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Upload failed',
        });
    }
});
// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});
const server = app.listen(PORT, () => {
    console.log(`🚀 Upload server running on http://localhost:${PORT}`);
    console.log(`📁 SFTP Host: ${process.env.O2SWITCH_SFTP_HOST}`);
    console.log(`📍 Base Path: ${process.env.O2SWITCH_BASE_PATH}`);
});
// Increase timeout for large file uploads (10 minutes)
server.timeout = 600000;
server.keepAliveTimeout = 600000;
