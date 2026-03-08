const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper to extract URL from text
function extractUrl(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/;
    const match = text.match(urlRegex);
    return match ? match[0] : null;
}

// Helper to extract video ID from URL
async function getDouyinVideo(inputUrl) {
    try {
        let url = extractUrl(inputUrl);
        if (!url) throw new Error('Invalid URL');

        console.log('Processing URL:', url);

        // 1. Get the redirected URL (if short link) and HTML content
        const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
        
        // Use a cookie jar to store cookies (simple implementation)
        let cookies = '';

        const response = await axios.get(url, {
            headers: { 
                'User-Agent': userAgent,
                // 'Cookie': cookies // If we had previous cookies
            },
            maxRedirects: 5,
            validateStatus: function (status) {
                return status >= 200 && status < 400; // Accept 3xx to handle redirects manually if needed, but axios follows by default
            }
        });
        
        const finalUrl = response.request.res.responseUrl || url; 
        console.log('Final URL:', finalUrl);
        
        const html = response.data;

        // 2. Try to parse RENDER_DATA
        // Pattern: <script id="RENDER_DATA" type="application/json">...encoded_json...</script>
        const renderDataMatch = html.match(/<script id="RENDER_DATA" type="application\/json">(.*?)<\/script>/);
        let videoDetail = null;

        if (renderDataMatch) {
            try {
                const rawData = renderDataMatch[1];
                const decodedData = decodeURIComponent(rawData);
                const jsonData = JSON.parse(decodedData);
                
                if (jsonData.app && jsonData.app.videoDetail) {
                    videoDetail = jsonData.app.videoDetail;
                } else if (jsonData.loaderData) {
                     // Try to find a key that looks like video_...
                     const videoKey = Object.keys(jsonData.loaderData).find(k => k.startsWith('video_'));
                     if (videoKey && jsonData.loaderData[videoKey].videoInfo && jsonData.loaderData[videoKey].videoInfo.res) {
                         videoDetail = jsonData.loaderData[videoKey].videoInfo.res;
                     }
                }
            } catch (e) {
                console.error('Error parsing RENDER_DATA:', e);
            }
        }

        // 3. Fallback: Try _ROUTER_DATA
        if (!videoDetail) {
             // More robust extraction for _ROUTER_DATA
             const routerDataStart = html.indexOf('window._ROUTER_DATA =');
             if (routerDataStart !== -1) {
                 try {
                     const sub = html.substring(routerDataStart);
                     const scriptEnd = sub.indexOf('</script>');
                     if (scriptEnd !== -1) {
                         let jsonStr = sub.substring('window._ROUTER_DATA ='.length, scriptEnd).trim();
                         // Remove trailing semicolon if exists
                         if (jsonStr.endsWith(';')) {
                             jsonStr = jsonStr.slice(0, -1);
                         }
                         
                         const jsonData = JSON.parse(jsonStr);
                         
                         if (jsonData.loaderData) {
                             // Iterate over keys to find the one containing video info
                             // Key format: "video_(id)/page"
                             // Avoid "video_layout" or "video_page" (generic)
                             const videoKey = Object.keys(jsonData.loaderData).find(k => k === 'video_(id)/page' || k.match(/video_\d+\/page/));
                             
                             if (videoKey) {
                                 const videoData = jsonData.loaderData[videoKey];
                                 // Check for videoInfoRes (seen in recent debug)
                                 if (videoData.videoInfoRes && videoData.videoInfoRes.item_list && videoData.videoInfoRes.item_list.length > 0) {
                                     videoDetail = videoData.videoInfoRes.item_list[0];
                                 } 
                                 // Check for old structure videoInfo.res
                                 else if (videoData.videoInfo && videoData.videoInfo.res && videoData.videoInfo.res.item_list && videoData.videoInfo.res.item_list.length > 0) {
                                      videoDetail = videoData.videoInfo.res.item_list[0];
                                 }
                             }
                         }
                     }
                 } catch (e) {
                     console.error('Error parsing _ROUTER_DATA:', e);
                 }
             }
        }



        if (!videoDetail) {
             // Fallback 2: Regex search for aweme_detail in text (less reliable)
             // Sometimes the data is just in a large JSON object not assigned to a specific variable we know
             console.log('Could not find structured data, trying regex for aweme_detail...');
             // This is risky as it might match truncated data
        }

        if (!videoDetail) {
            throw new Error('Could not extract video details from HTML. The page structure might have changed.');
        }

        // 4. Extract info from videoDetail
        // videoDetail should be the 'aweme_detail' object or similar
        const item = videoDetail.aweme_detail || videoDetail; // adjust based on structure

        if (!item || !item.video) {
             throw new Error('Invalid video detail structure');
        }

        // Get play address and replace playwm with play
        let playAddr = item.video.play_addr.url_list[0];
        if (playAddr.includes('playwm')) {
            playAddr = playAddr.replace('playwm', 'play');
        }

        return {
            title: item.desc,
            cover: item.video.cover.url_list[0],
            url: playAddr,
            author: item.author.nickname
        };

    } catch (error) {
        console.error('Error parsing Douyin video:', error.message);
        throw error;
    }
}

app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const videoData = await getDouyinVideo(url);
        res.json(videoData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to parse video', details: error.message });
    }
});

// Proxy endpoint to download video (to avoid CORS or Referer issues on frontend)
app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL required');

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            }
        });
        
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        res.setHeader('Content-Type', 'video/mp4');
        response.data.pipe(res);
    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).send('Failed to download video');
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
