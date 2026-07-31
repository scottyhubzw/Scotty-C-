/**
 * .play — YouTube to MP3
 * Chain: Madrin YTDL → Drexapp ytplay
 * Scotty♤C©
 */
const yts      = require('yt-search');
const axios    = require('axios');
const settings = require('../settings');
const { reply } = require('./_helper');

const MADRIN     = 'https://api-madrin.zone.id';
const MADRIN_KEY = settings.MADRIN_KEY || 'test';
const DREXAPP    = 'https://api.drexapp.space';

async function get(url, params = {}, timeout = 30000) {
    const { data } = await axios.get(url, { params, timeout, headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }});
    return data;
}

// ── API: Madrin YTDL ──────────────────────────────────────────────────────
// Example: https://api-madrin.zone.id/download/ytdl?apikey=test&url=...
async function tryMadrin(videoUrl) {
    const data = await get(`${MADRIN}/download/ytdl`, { apikey: MADRIN_KEY, url: videoUrl });
    const res  = data?.result || data;
    const url  = res?.dl_url || res?.download_url || res?.audio || res?.url || res?.link;
    if (!url) throw new Error('madrin no url');
    return { url, title: res?.title, duration: res?.duration, size: res?.size };
}

// ── API: Drexapp ytplay ───────────────────────────────────────────────────
// Example: https://api.drexapp.space/downloader/ytplay?q=Faded
// Takes a raw search query (or title) and resolves + returns an mp3 link itself.
async function tryDrexapp(q) {
    const data = await get(`${DREXAPP}/downloader/ytplay`, { q });
    const res  = data?.result || data;
    const url  = res?.download_url || res?.dl_url || res?.url;
    if (!url) throw new Error('drexapp no url');
    return { url, title: res?.title, duration: res?.duration, size: null, channel: res?.channel };
}

module.exports = async (sock, chatId, message, args) => {
    const query = args.join(' ').trim();
    if (!query) return reply(sock, chatId, '❌ Usage: .play <song name or YouTube link>', message);

    let loadingKey = null;

    try {
        const loadingMsg = await sock.sendMessage(chatId,
            { text: `🎵 Searching: *${query}*...` },
            { quoted: message }
        );
        loadingKey = loadingMsg?.key;

        // Resolve YouTube URL
        const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
        let videoUrl, videoTitle;

        if (ytRegex.test(query)) {
            videoUrl   = query;
            videoTitle = query;
        } else {
            const { videos } = await yts(query);
            if (!videos?.length) throw new Error('No results found. Try a different name.');
            videoUrl   = videos[0].url;
            videoTitle = videos[0].title;
        }

        // ── Try Madrin YTDL, then fall back to Drexapp ytplay ───────────────
        let result = null;

        try {
            result = await tryMadrin(videoUrl);
            console.log(`[play] ✅ Madrin succeeded`);
        } catch (e) {
            console.warn(`[play] ❌ Madrin failed: ${e.message}`);
            try {
                result = await tryDrexapp(query);
                console.log(`[play] ✅ Drexapp ytplay succeeded`);
            } catch (e2) {
                console.warn(`[play] ❌ Drexapp failed: ${e2.message}`);
                throw new Error(`All APIs failed: ${e2.message}`);
            }
        }

        if (!result?.url) throw new Error('No download URL returned');

        const title = result.title || videoTitle || query;

        // ── Download + validate the actual audio bytes before sending ──────
        // (Sending {audio:{url}} directly trusts the remote host to serve a
        // real mp3 with correct headers — some of these APIs return an HTML
        // error page with a 200 status, or a broken/empty file, which is why
        // WhatsApp was rendering it as a 0:00 generic AUD-*.mp3 voice note.)
        const audioRes = await axios.get(result.url, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const buffer      = Buffer.from(audioRes.data);
        const contentType = (audioRes.headers['content-type'] || '').toLowerCase();

        const looksLikeAudio =
            contentType.includes('audio') ||
            contentType.includes('octet-stream') ||
            (buffer.length > 2000 && !contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json'));

        if (buffer.length < 2000 || !looksLikeAudio) {
            throw new Error(`Invalid audio response (type: ${contentType || 'unknown'}, size: ${buffer.length}b)`);
        }

        // Delete loading msg
        if (loadingKey) {
            try { await sock.sendMessage(chatId, { delete: loadingKey }); } catch {}
        }

        // Info card
        await sock.sendMessage(chatId, {
            text:
                `🎵 *${title}*\n` +
                (result.duration ? `⏱️ ${result.duration}\n` : '') +
                (result.size     ? `📦 ${result.size}\n`     : '') +
                `⬇️ Sending...`
        }, { quoted: message });

        // Send audio as a buffer (not a bare url) so WhatsApp gets real bytes
        // and picks up duration correctly.
        await sock.sendMessage(chatId, {
            audio:    buffer,
            mimetype: 'audio/mpeg',
            fileName: `${title.replace(/[^\w\s]/gi, '').trim() || 'audio'}.mp3`,
            ptt:      false
        }, { quoted: message });

    } catch (e) {
        if (loadingKey) {
            try { await sock.sendMessage(chatId, { delete: loadingKey }); } catch {}
        }
        console.error('[play] fatal:', e.message);
        await reply(sock, chatId,
            `❌ Download failed. Try: *.song ${args.join(' ')}*`,
            message
        );
    }
};
