import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
// Helper function to get Supabase admin client (uses service key, bypasses RLS)
function getSupabaseAdminClient() {
    if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw new Error('Supabase admin credentials not configured');
    }
    return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    });
}
/**
 * Generate a secure random token for share links
 */
export function generateShareToken() {
    return crypto.randomBytes(16).toString('hex'); // 32 character hex string
}
/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password) {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
}
/**
 * Verify a password against a bcrypt hash
 */
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
/**
 * Create a new share link in the database
 */
export async function createShareLink(options) {
    const supabase = getSupabaseAdminClient();
    // Generate unique token
    let token = generateShareToken();
    let isUnique = false;
    // Ensure token is unique (very unlikely to collide, but check anyway)
    while (!isUnique) {
        const { data: existing } = await supabase
            .from('shared_links')
            .select('token')
            .eq('token', token)
            .single();
        if (!existing) {
            isUnique = true;
        }
        else {
            token = generateShareToken();
        }
    }
    // Calculate expiration date if specified
    let expiresAt = null;
    if (options.expiresIn) {
        const expirationDate = new Date(Date.now() + options.expiresIn);
        expiresAt = expirationDate.toISOString();
    }
    // Hash password if provided
    let passwordHash = null;
    if (options.password) {
        passwordHash = await hashPassword(options.password);
    }
    // Insert into database
    const { data, error } = await supabase
        .from('shared_links')
        .insert({
        file_path: options.filePath,
        file_name: options.fileName,
        file_size: options.fileSize,
        token,
        created_by: options.createdBy,
        expires_at: expiresAt,
        password_hash: passwordHash,
        max_downloads: options.maxDownloads || null,
    })
        .select()
        .single();
    if (error) {
        console.error('Error creating share link:', error);
        throw new Error('Failed to create share link');
    }
    return data;
}
/**
 * Get share link information by token
 */
export async function getShareLink(token) {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from('shared_links')
        .select('*')
        .eq('token', token)
        .single();
    if (error) {
        console.error('Error getting share link:', error);
        return null;
    }
    return data;
}
/**
 * Validate if a share link can be accessed
 */
export async function validateShareLink(token, password) {
    const link = await getShareLink(token);
    if (!link) {
        return { valid: false, reason: 'Link not found' };
    }
    // Check if active
    if (!link.is_active) {
        return { valid: false, reason: 'Link has been deactivated' };
    }
    // Check if expired
    if (link.expires_at) {
        const expirationDate = new Date(link.expires_at);
        if (expirationDate < new Date()) {
            return { valid: false, reason: 'Link has expired' };
        }
    }
    // Check download limit
    if (link.max_downloads !== null && link.download_count >= link.max_downloads) {
        return { valid: false, reason: 'Download limit reached' };
    }
    // Check password if required
    if (link.password_hash) {
        if (!password) {
            return { valid: false, reason: 'Password required' };
        }
        const passwordValid = await verifyPassword(password, link.password_hash);
        if (!passwordValid) {
            return { valid: false, reason: 'Invalid password' };
        }
    }
    return { valid: true, link };
}
/**
 * Increment the download count for a share link
 */
export async function incrementDownloadCount(token) {
    const supabase = getSupabaseAdminClient();
    // First get current count
    const { data: current, error: fetchError } = await supabase
        .from('shared_links')
        .select('download_count')
        .eq('token', token)
        .single();
    if (fetchError) {
        console.error('Error fetching download count:', fetchError);
        throw new Error('Failed to fetch download count');
    }
    // Then update with incremented value
    const { error } = await supabase
        .from('shared_links')
        .update({
        download_count: (current?.download_count || 0) + 1,
        last_accessed_at: new Date().toISOString(),
    })
        .eq('token', token);
    if (error) {
        console.error('Error incrementing download count:', error);
        throw new Error('Failed to update download count');
    }
}
/**
 * Get all share links created by a user
 */
export async function getUserShareLinks(userId) {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from('shared_links')
        .select('*')
        .eq('created_by', userId)
        .order('created_at', { ascending: false });
    if (error) {
        console.error('Error getting user share links:', error);
        throw new Error('Failed to get share links');
    }
    return data;
}
/**
 * Deactivate a share link (soft delete)
 */
export async function deactivateShareLink(linkId, userId) {
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from('shared_links')
        .update({ is_active: false })
        .eq('id', linkId)
        .eq('created_by', userId);
    if (error) {
        console.error('Error deactivating share link:', error);
        throw new Error('Failed to deactivate share link');
    }
}
/**
 * Delete a share link permanently
 */
export async function deleteShareLink(linkId, userId) {
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
        .from('shared_links')
        .delete()
        .eq('id', linkId)
        .eq('created_by', userId);
    if (error) {
        console.error('Error deleting share link:', error);
        throw new Error('Failed to delete share link');
    }
}
/**
 * Clean up expired links (can be called periodically)
 */
export async function cleanupExpiredLinks() {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
        .from('shared_links')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select();
    if (error) {
        console.error('Error cleaning up expired links:', error);
        return 0;
    }
    return data?.length || 0;
}
