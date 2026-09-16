# Instagram Username and bio Checker

A small Express service that checks whether Instagram usernames exist and, optionally, pulls basic public profile info (bio, follower count, etc.). Uses [Crawlee](https://crawlee.dev/) with residential proxies via [Apify](https://apify.com/).

## Requirements

- Node.js 18+
- An Apify account/token with access to residential proxies (`Actor.createProxyConfiguration`)

## Install

```bash
npm install express cors @crawlee/cheerio apify
```

## Run

```bash
node server.js
```

Server starts on `http://localhost:3000` (or `PORT` env var).

## Endpoints

### `GET /`
Health check.

### `POST /check`
Checks whether each username exists.

**Request body:**
```json
{ "usernames": ["someuser", "@another_user"] }
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "username": "someuser",
      "exists": true,
      "blocked": false,
      "statusCode": 200,
      "profileUrl": "https://www.instagram.com/someuser/",
      "checkedAt": "2026-09-16T12:00:00.000Z"
    }
  ],
  "invalid": []
}
```

### `POST /bio`
Same input shape as `/check`, but returns full profile info where available: `fullName`, `bio`, `isPrivate`, `isVerified`, `followers`, `following`, `posts`.

## Notes & limits

- Max **100 usernames per request**. Duplicates are removed automatically.
- Usernames must match Instagram's allowed character set (`a-z`, `0-9`, `.`, `_`); anything else is rejected and returned in the `invalid` array.
- `exists: null` means the check was inconclusive (request failed, timed out, etc.).
- `blocked: true` means Instagram served a login/challenge page instead of the profile — this is different from the profile not existing, and tends to happen more under heavy traffic or with an exhausted proxy pool.
- Instagram frequently changes its markup and rate-limits scrapers. `/bio` extraction (especially follower counts and bio text) may degrade over time and isn't guaranteed to stay accurate.
- Each request runs its own isolated Crawlee queue so concurrent calls don't interfere with each other.

## Disclaimer

Scraping Instagram may violate its Terms of Service. Use at your own risk and review Instagram's current terms before deploying this in production.
