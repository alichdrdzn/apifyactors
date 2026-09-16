import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { CheerioCrawler, RequestQueue } from '@crawlee/cheerio';
import { Actor } from 'apify';

const app = express();
const PORT = process.env.PORT || 3000;

const MAX_USERNAMES_PER_REQUEST = 100;
const USERNAME_REGEX = /^[a-zA-Z0-9._]{1,30}$/;

app.use(cors());
app.use(express.json());

// Initialize Actor once at startup
await Actor.init();

const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// ============================================
// Shared helpers
// ============================================

/**
 * Cleans, validates, and de-duplicates the incoming usernames array.
 * Returns { cleanUsernames, invalid } where invalid holds anything
 * that didn't pass the allowlist so callers can be told about it.
 */
function sanitizeUsernames(usernames) {
  const seen = new Set();
  const cleanUsernames = [];
  const invalid = [];

  for (const raw of usernames) {
    const u = String(raw).trim().replace(/^@/, '');
    if (!u) continue;

    if (!USERNAME_REGEX.test(u)) {
      invalid.push(raw);
      continue;
    }

    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleanUsernames.push(u);
  }

  return { cleanUsernames, invalid };
}

function validateBody(req, res) {
  const { usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    res.status(400).json({ error: 'usernames must be a non-empty array' });
    return null;
  }

  const { cleanUsernames, invalid } = sanitizeUsernames(usernames);

  if (cleanUsernames.length === 0) {
    res.status(400).json({ error: 'no valid usernames provided', invalid });
    return null;
  }

  if (cleanUsernames.length > MAX_USERNAMES_PER_REQUEST) {
    res.status(400).json({
      error: `too many usernames; max ${MAX_USERNAMES_PER_REQUEST} per request`,
      received: cleanUsernames.length,
    });
    return null;
  }

  return { cleanUsernames, invalid };
}

// ============================================
// CHECK if username exists
// ============================================
app.post('/check', async (req, res) => {
  const validated = validateBody(req, res);
  if (!validated) return; // response already sent
  const { cleanUsernames, invalid } = validated;

  // Isolated, uniquely-named queue so concurrent requests never
  // share or purge each other's storage.
  const requestQueue = await RequestQueue.open(`check-${randomUUID()}`);
  const resultsByUsername = new Map();

  try {
    const crawler = new CheerioCrawler({
      proxyConfiguration,
      requestQueue,
      maxConcurrency: 5,
      maxRequestsPerMinute: 60,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 20,

      async requestHandler({ request, $, response }) {
        const username = request.userData.username;
        const status = response?.statusCode || 0;

        const title = $('title').text().toLowerCase() || '';
        const hasMeta = $('meta[property="og:title"]').length > 0;
        const looksBlocked = title.includes('login') || title.includes('challenge');

        let exists = null;
        let blocked = false;

        if (status === 200 && hasMeta && !looksBlocked && !title.includes('not found')) {
          exists = true;
        } else if (status === 404) {
          exists = false;
        } else if (status === 200 && looksBlocked) {
          // Instagram served a login/challenge interstitial instead of the
          // profile — this is NOT the same as "couldn't determine", flag it.
          blocked = true;
        }

        resultsByUsername.set(username, {
          username,
          exists,
          blocked,
          statusCode: status,
          profileUrl: `https://www.instagram.com/${username}/`,
          checkedAt: new Date().toISOString(),
        });
      },

      failedRequestHandler({ request }) {
        const username = request.userData.username;
        resultsByUsername.set(username, {
          username,
          exists: null,
          blocked: false,
          statusCode: 0,
          profileUrl: `https://www.instagram.com/${username}/`,
          checkedAt: new Date().toISOString(),
        });
      },
    });

    await crawler.run(
      cleanUsernames.map((username) => ({
        url: `https://www.instagram.com/${username}/`,
        userData: { username },
        uniqueKey: username,
      }))
    );

    // Preserve the order the caller sent usernames in.
    const results = cleanUsernames.map(
      (u) =>
        resultsByUsername.get(u) || {
          username: u,
          exists: null,
          blocked: false,
          statusCode: 0,
          profileUrl: `https://www.instagram.com/${u}/`,
          checkedAt: new Date().toISOString(),
        }
    );

    res.json({ success: true, results, invalid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // Always clean up the isolated queue, even on error.
    await requestQueue.drop().catch(() => {});
  }
});

// ============================================
// GET BIO (separate endpoint)
// ============================================
app.post('/bio', async (req, res) => {
  const validated = validateBody(req, res);
  if (!validated) return;
  const { cleanUsernames, invalid } = validated;

  const requestQueue = await RequestQueue.open(`bio-${randomUUID()}`);
  const resultsByUsername = new Map();

  try {
    const crawler = new CheerioCrawler({
      proxyConfiguration,
      requestQueue,
      maxConcurrency: 5,
      maxRequestsPerMinute: 60,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 25,

      async requestHandler({ request, $, response }) {
        const username = request.userData.username;
        const status = response?.statusCode || 0;

        let bio = null;
        let fullName = null;
        let exists = false;
        let isPrivate = null;
        let isVerified = null;
        let followers = null;
        let following = null;
        let posts = null;
        let blocked = false;

        if (status === 200) {
          const title = $('title').text().toLowerCase() || '';
          if (title.includes('login') || title.includes('challenge')) {
            blocked = true;
          } else {
            exists = true;

            // Try JSON-LD first
            const jsonLd = $('script[type="application/ld+json"]').html();
            if (jsonLd) {
              try {
                const data = JSON.parse(jsonLd);
                fullName = data.name || null;
                bio = data.description || null;
              } catch (e) {
                // ignore malformed JSON-LD, fall through to regex scan
              }
            }

            // Fallback: search inside all scripts
            $('script').each((_, el) => {
              const content = $(el).html() || '';

              if (!bio) {
                const bioMatch = content.match(/"biography":"(.*?)"/);
                if (bioMatch && bioMatch[1]) {
                  bio = bioMatch[1]
                    .replace(/\\n/g, '\n')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
                }
              }

              if (!fullName) {
                const nameMatch = content.match(/"full_name":"(.*?)"/);
                if (nameMatch && nameMatch[1]) {
                  fullName = nameMatch[1].replace(/\\"/g, '"');
                }
              }

              if (isPrivate === null) {
                const privateMatch = content.match(/"is_private":(true|false)/);
                if (privateMatch) isPrivate = privateMatch[1] === 'true';
              }

              if (isVerified === null) {
                const verifiedMatch = content.match(/"is_verified":(true|false)/);
                if (verifiedMatch) isVerified = verifiedMatch[1] === 'true';
              }

              if (followers === null) {
                const followersMatch = content.match(/"edge_followed_by":\{"count":(\d+)\}/);
                if (followersMatch) followers = parseInt(followersMatch[1], 10);
              }

              if (following === null) {
                const followingMatch = content.match(/"edge_follow":\{"count":(\d+)\}/);
                if (followingMatch) following = parseInt(followingMatch[1], 10);
              }

              if (posts === null) {
                const postsMatch = content.match(/"edge_owner_to_timeline_media":\{"count":(\d+)\}/);
                if (postsMatch) posts = parseInt(postsMatch[1], 10);
              }
            });

            // Final fallback to og tags
            if (!bio) {
              bio = $('meta[property="og:description"]').attr('content') || null;
            }
            if (!fullName) {
              fullName = $('meta[property="og:title"]').attr('content') || null;
            }
          }
        }

        resultsByUsername.set(username, {
          username,
          exists,
          blocked,
          fullName,
          bio,
          isPrivate,
          isVerified,
          followers,
          following,
          posts,
          statusCode: status,
          profileUrl: `https://www.instagram.com/${username}/`,
          checkedAt: new Date().toISOString(),
        });
      },

      failedRequestHandler({ request }) {
        const username = request.userData.username;
        resultsByUsername.set(username, {
          username,
          exists: null,
          blocked: false,
          fullName: null,
          bio: null,
          isPrivate: null,
          isVerified: null,
          followers: null,
          following: null,
          posts: null,
          statusCode: 0,
          profileUrl: `https://www.instagram.com/${username}/`,
          checkedAt: new Date().toISOString(),
        });
      },
    });

    await crawler.run(
      cleanUsernames.map((username) => ({
        url: `https://www.instagram.com/${username}/`,
        userData: { username },
        uniqueKey: username,
      }))
    );

    const results = cleanUsernames.map(
      (u) =>
        resultsByUsername.get(u) || {
          username: u,
          exists: null,
          blocked: false,
          fullName: null,
          bio: null,
          isPrivate: null,
          isVerified: null,
          followers: null,
          following: null,
          posts: null,
          statusCode: 0,
          profileUrl: `https://www.instagram.com/${u}/`,
          checkedAt: new Date().toISOString(),
        }
    );

    res.json({ success: true, results, invalid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await requestQueue.drop().catch(() => {});
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Instagram Username Checker is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
