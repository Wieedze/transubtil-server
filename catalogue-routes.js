import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();
// Initialize Supabase for auth check
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
// Helper to verify admin user
async function verifyAdmin(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    const token = authHeader.substring(7);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        return false;
    }
    // Check if user is admin
    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
    return profile?.role === 'admin';
}
// Paths to data files
const ARTISTS_FILE = path.join(__dirname, '../src/data/artists.ts');
const RELEASES_FILE = path.join(__dirname, '../src/data/releases.ts');
// Parse artists.ts file to extract artistsData array
function parseArtistsFile() {
    const content = fs.readFileSync(ARTISTS_FILE, 'utf-8');
    // Extract the artistsData array content
    const match = content.match(/const artistsData = \[([\s\S]*?)\n\]/);
    if (!match) {
        throw new Error('Could not parse artists file');
    }
    // Parse the array by evaluating it (safe since we control the file)
    const arrayContent = `[${match[1]}]`;
    // Use Function constructor to safely evaluate
    const artists = eval(arrayContent);
    return artists;
}
// Parse releases.ts file to extract releases array
function parseReleasesFile() {
    const content = fs.readFileSync(RELEASES_FILE, 'utf-8');
    // Extract the releases array content
    const match = content.match(/export const releases: Release\[\] = \[([\s\S]*?)\n\]/);
    if (!match) {
        throw new Error('Could not parse releases file');
    }
    const arrayContent = `[${match[1]}]`;
    const releases = eval(arrayContent);
    return releases;
}
// Generate TypeScript code for an artist object
function artistToTS(artist) {
    const social = Object.entries(artist.social || {})
        .filter(([_, v]) => v)
        .map(([k, v]) => `      ${k}: "${v}"`)
        .join(',\n');
    const videos = artist.videos?.length
        ? `\n    videos: [\n${artist.videos.map((v) => `      "${v}"`).join(',\n')}\n    ],`
        : '';
    return `  {
    id: ${artist.id},
    name: "${artist.name}",
    act: "${artist.act}",
    description: "${(artist.description || '').replace(/"/g, '\\"').replace(/\n/g, '\\n')}",
    style: [${artist.style.map((s) => `"${s}"`).join(', ')}],
    social: {
${social}
    },
    country: "${artist.country}",
    image_url: "${artist.image_url}",${videos}
  }`;
}
// Generate TypeScript code for a release object
function releaseToTS(release) {
    let code = `  {
    id: ${release.id},
    title: "${release.title}",
    artist: "${release.artist}",
    type: "${release.type}",
    releaseDate: "${release.releaseDate}",
    catalogNumber: "${release.catalogNumber || ''}",
    coverUrl: "${release.coverUrl}",
    bandcampUrl: "${release.bandcampUrl}",
    bandcampId: "${release.bandcampId}",`;
    if (release.description) {
        code += `\n    description: "${release.description.replace(/"/g, '\\"')}",`;
    }
    if (release.tracklist?.length) {
        code += `\n    tracklist: [${release.tracklist.map((t) => `"${t}"`).join(', ')}],`;
    }
    code += '\n  }';
    return code;
}
// Write artists back to file
function writeArtistsFile(artists) {
    const artistsCode = artists.map(artistToTS).join(',\n');
    const fileContent = `import type { Artist } from "../types/artist"
import { slugify } from "../utils/slugify"

const artistsData = [
${artistsCode}
]

// Add slugs to all artists
export const artists: Artist[] = artistsData.map((artist) => ({
  ...artist,
  slug: slugify(artist.name),
  videos: artist.videos || [],
}))

// Helper functions
export function getArtistBySlug(slug: string): Artist | undefined {
  return artists.find((artist) => artist.slug === slug)
}

export function getArtistById(id: number): Artist | undefined {
  return artists.find((artist) => artist.id === id)
}

export function getAllStyles(): string[] {
  const styles = new Set<string>()
  artists.forEach((artist) => {
    artist.style.forEach((s) => styles.add(s))
  })
  return Array.from(styles).sort()
}

export function getAllCountries(): string[] {
  const countries = new Set<string>()
  artists.forEach((artist) => countries.add(artist.country))
  return Array.from(countries).sort()
}
`;
    fs.writeFileSync(ARTISTS_FILE, fileContent, 'utf-8');
}
// Write releases back to file
function writeReleasesFile(releases) {
    const releasesCode = releases.map(releaseToTS).join(',\n');
    const fileContent = `import type { Release } from "../types/release"

export const releases: Release[] = [
${releasesCode}
]

// Helper functions
export function getReleaseById(id: number): Release | undefined {
  return releases.find((release) => release.id === id)
}

export function getReleasesByArtist(artistName: string): Release[] {
  return releases.filter((release) => {
    const releaseLower = release.artist.toLowerCase()
    const titleLower = release.title.toLowerCase()
    const artistLower = artistName.toLowerCase()

    // Match if artist name is in the artist field or in the title
    return releaseLower.includes(artistLower) || titleLower.includes(artistLower)
  })
}

export function getReleasesByType(type: Release["type"]): Release[] {
  return releases.filter((release) => release.type === type)
}

export function getReleasesByYear(year: string): Release[] {
  return releases.filter((release) => release.releaseDate.includes(year))
}
`;
    fs.writeFileSync(RELEASES_FILE, fileContent, 'utf-8');
}
// GET /api/catalogue/artists - Get all artists
router.get('/artists', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const artists = parseArtistsFile();
        res.json({ success: true, artists });
    }
    catch (error) {
        console.error('Error reading artists:', error);
        res.status(500).json({ error: 'Failed to read artists' });
    }
});
// POST /api/catalogue/artists - Add a new artist
router.post('/artists', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const newArtist = req.body;
        const artists = parseArtistsFile();
        // Generate new ID
        const maxId = Math.max(...artists.map((a) => a.id), 0);
        newArtist.id = maxId + 1;
        artists.push(newArtist);
        writeArtistsFile(artists);
        res.json({ success: true, artist: newArtist });
    }
    catch (error) {
        console.error('Error adding artist:', error);
        res.status(500).json({ error: 'Failed to add artist' });
    }
});
// DELETE /api/catalogue/artists/:id - Delete an artist
router.delete('/artists/:id', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const id = parseInt(req.params.id);
        let artists = parseArtistsFile();
        const initialLength = artists.length;
        artists = artists.filter((a) => a.id !== id);
        if (artists.length === initialLength) {
            return res.status(404).json({ error: 'Artist not found' });
        }
        writeArtistsFile(artists);
        res.json({ success: true });
    }
    catch (error) {
        console.error('Error deleting artist:', error);
        res.status(500).json({ error: 'Failed to delete artist' });
    }
});
// GET /api/catalogue/releases - Get all releases
router.get('/releases', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const releases = parseReleasesFile();
        res.json({ success: true, releases });
    }
    catch (error) {
        console.error('Error reading releases:', error);
        res.status(500).json({ error: 'Failed to read releases' });
    }
});
// POST /api/catalogue/releases - Add a new release
router.post('/releases', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const newRelease = req.body;
        const releases = parseReleasesFile();
        // Generate new ID
        const maxId = Math.max(...releases.map((r) => r.id), 0);
        newRelease.id = maxId + 1;
        // Add to beginning of array (newest first)
        releases.unshift(newRelease);
        writeReleasesFile(releases);
        res.json({ success: true, release: newRelease });
    }
    catch (error) {
        console.error('Error adding release:', error);
        res.status(500).json({ error: 'Failed to add release' });
    }
});
// DELETE /api/catalogue/releases/:id - Delete a release
router.delete('/releases/:id', async (req, res) => {
    try {
        const isAdmin = await verifyAdmin(req.headers.authorization);
        if (!isAdmin) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const id = parseInt(req.params.id);
        let releases = parseReleasesFile();
        const initialLength = releases.length;
        releases = releases.filter((r) => r.id !== id);
        if (releases.length === initialLength) {
            return res.status(404).json({ error: 'Release not found' });
        }
        writeReleasesFile(releases);
        res.json({ success: true });
    }
    catch (error) {
        console.error('Error deleting release:', error);
        res.status(500).json({ error: 'Failed to delete release' });
    }
});
export default router;
