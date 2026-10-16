const express = require('express');
const axios = require('axios');
const router = express.Router();

/**
 * Universal Stream Proxy with HTTP Range (206 Partial Content) support & Self-Healing Auto-Failover
 * Injects required Referer and User-Agent headers and automatically falls back to secondary mirrors
 * if a primary video stream returns HTTP 403/404/5xx or times out.
 */
router.get('/', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('Missing target stream url parameter');
    }

    // Parse fallback mirrors for Self-Healing Stream Failover
    let fallbackUrls = [];
    if (req.query.fallbacks) {
        try {
            if (req.query.fallbacks.startsWith('[')) {
                fallbackUrls = JSON.parse(req.query.fallbacks);
            } else {
                fallbackUrls = req.query.fallbacks.split(',').map(u => decodeURIComponent(u.trim())).filter(Boolean);
            }
        } catch (_) {
            fallbackUrls = [];
        }
    }

    const candidateUrls = [targetUrl, ...fallbackUrls.filter(u => u && u !== targetUrl)];

    let customHeaders = {};
    try {
        if (req.query.headers) {
            customHeaders = JSON.parse(req.query.headers);
        }
    } catch (_) {}

    const clientHeaders = {
        'User-Agent': customHeaders['User-Agent'] || customHeaders['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(customHeaders['Referer'] || customHeaders['referer'] ? { 'Referer': customHeaders['Referer'] || customHeaders['referer'] } : {}),
        ...(customHeaders['Origin'] || customHeaders['origin'] ? { 'Origin': customHeaders['Origin'] || customHeaders['origin'] } : {})
    };

    if (req.headers.range) {
        clientHeaders['Range'] = req.headers.range;
    }

    let lastError = null;
    for (let i = 0; i < candidateUrls.length; i++) {
        const urlToTry = candidateUrls[i];
        try {
            const remoteRes = await axios({
                method: 'get',
                url: urlToTry,
                headers: clientHeaders,
                responseType: 'stream',
                timeout: candidateUrls.length > 1 ? 8000 : 12000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400
            });

            if (i > 0) {
                console.log(`[StreamProxy] Auto-healed stream using mirror ${i}/${candidateUrls.length - 1}: ${urlToTry.substring(0, 60)}...`);
            }

            res.status(remoteRes.status);
            const copyHeaders = [
                'content-type',
                'content-length',
                'content-range',
                'accept-ranges',
                'content-disposition',
                'cache-control'
            ];
            for (const h of copyHeaders) {
                if (remoteRes.headers[h]) {
                    res.setHeader(h, remoteRes.headers[h]);
                }
            }
            res.setHeader('Access-Control-Allow-Origin', '*');

            if (process.env.VERCEL && !customHeaders['Referer'] && !customHeaders['referer'] && !customHeaders['Origin'] && !customHeaders['origin'] && candidateUrls.length === 1) {
                // Vercel Serverless limits execution time for unbounded media.
                // Only redirect directly when custom referer/origin headers are NOT required and no fallbacks exist.
                return res.redirect(302, urlToTry);
            }

            remoteRes.data.pipe(res);

            req.on('close', () => {
                if (remoteRes.data && typeof remoteRes.data.destroy === 'function') {
                    remoteRes.data.destroy();
                }
            });
            return; // Successfully streamed!
        } catch (err) {
            lastError = err;
            console.warn(`[StreamProxy] Mirror attempt ${i + 1}/${candidateUrls.length} failed (${err.message}) for: ${urlToTry.substring(0, 60)}...`);
            // Continue loop to try next fallback mirror
        }
    }

    // Fallback: Redirect client directly if all candidate mirrors fail
    res.redirect(302, targetUrl);
});

module.exports = router;
