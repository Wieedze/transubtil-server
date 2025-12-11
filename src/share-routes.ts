import express from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  createShareLink,
  getUserShareLinks,
  getShareLink,
  validateShareLink,
  incrementDownloadCount,
  deactivateShareLink,
  deleteShareLink,
} from './file-sharing.js';

const router = express.Router();

// Helper function to get Supabase client for user authentication
function getSupabaseClient() {
  if (!process.env.VITE_SUPABASE_URL || !process.env.VITE_SUPABASE_ANON_KEY) {
    throw new Error('Supabase credentials not configured');
  }
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY
  );
}

// Helper function to get Supabase admin client
function getSupabaseAdminClient() {
  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase admin credentials not configured');
  }
  return createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

// Helper function to verify admin user
async function verifyAdminUser(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const supabase = getSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return null;
  }

  // Check if user is admin using admin client to bypass RLS
  const supabaseAdmin = getSupabaseAdminClient();
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id);

  if (!profiles || profiles.length === 0 || profiles[0].role !== 'admin') {
    return null;
  }

  return user;
}

// ===== ADMIN ROUTES (Protected) =====

/**
 * POST /api/share/create
 * Create a new share link for a file
 */
router.post('/create', async (req, res) => {
  try {
    const user = await verifyAdminUser(req.headers.authorization);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { filePath, fileName, fileSize, expiresIn, password, maxDownloads } = req.body;

    if (!filePath || !fileName || !fileSize) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create the share link
    const shareLink = await createShareLink({
      filePath,
      fileName,
      fileSize,
      createdBy: user.id,
      expiresIn,
      password,
      maxDownloads,
    });

    // Generate the public URL
    const baseUrl = process.env.VITE_APP_URL || 'http://localhost:5173';
    const shareUrl = `${baseUrl}/shared/${shareLink.token}`;

    res.json({
      success: true,
      shareLink: {
        ...shareLink,
        url: shareUrl,
      },
    });
  } catch (error) {
    console.error('Error creating share link:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

/**
 * GET /api/share/list
 * Get all share links created by the current admin user
 */
router.get('/list', async (req, res) => {
  try {
    const user = await verifyAdminUser(req.headers.authorization);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const shareLinks = await getUserShareLinks(user.id);

    // Add URLs to each link
    const baseUrl = process.env.VITE_APP_URL || 'http://localhost:5173';
    const linksWithUrls = shareLinks.map(link => ({
      ...link,
      url: `${baseUrl}/shared/${link.token}`,
    }));

    res.json({
      success: true,
      shareLinks: linksWithUrls,
    });
  } catch (error) {
    console.error('Error getting share links:', error);
    res.status(500).json({ error: 'Failed to get share links' });
  }
});

/**
 * PATCH /api/share/:id/deactivate
 * Deactivate a share link
 */
router.patch('/:id/deactivate', async (req, res) => {
  try {
    const user = await verifyAdminUser(req.headers.authorization);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    await deactivateShareLink(id, user.id);

    res.json({
      success: true,
      message: 'Share link deactivated',
    });
  } catch (error) {
    console.error('Error deactivating share link:', error);
    res.status(500).json({ error: 'Failed to deactivate share link' });
  }
});

/**
 * DELETE /api/share/:id
 * Delete a share link permanently
 */
router.delete('/:id', async (req, res) => {
  try {
    const user = await verifyAdminUser(req.headers.authorization);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    await deleteShareLink(id, user.id);

    res.json({
      success: true,
      message: 'Share link deleted',
    });
  } catch (error) {
    console.error('Error deleting share link:', error);
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

// ===== PUBLIC ROUTES (No authentication required) =====

/**
 * GET /api/shared/:token
 * Get information about a shared file (no download, just info)
 */
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const link = await getShareLink(token);

    if (!link) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Don't expose sensitive information
    res.json({
      success: true,
      file: {
        name: link.file_name,
        size: link.file_size,
        requiresPassword: !!link.password_hash,
        expiresAt: link.expires_at,
        maxDownloads: link.max_downloads,
        downloadCount: link.download_count,
        isActive: link.is_active,
      },
    });
  } catch (error) {
    console.error('Error getting shared file info:', error);
    res.status(500).json({ error: 'Failed to get file information' });
  }
});

/**
 * POST /api/shared/:token/download
 * Download a shared file
 */
router.post('/:token/download', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    // Validate the share link
    const validation = await validateShareLink(token, password);

    if (!validation.valid) {
      return res.status(403).json({
        error: validation.reason || 'Access denied',
      });
    }

    const link = validation.link!;

    // Get the file from SFTP (connexion déjà établie au démarrage)
    const { O2SwitchStorage } = await import('./sftp.js');
    const storage = O2SwitchStorage.getInstance();
    const fileBuffer = await storage.downloadAdminFile(link.file_path);

    // Increment download count
    await incrementDownloadCount(token);

    // Set headers for file download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(link.file_name)}"`);
    res.setHeader('Content-Length', fileBuffer.length);

    // Send the file
    res.send(fileBuffer);
  } catch (error) {
    console.error('Error downloading shared file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
