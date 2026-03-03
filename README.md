# GitHub Commits Leaderboard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-green.svg)](https://neon.tech/)
[![GitHub Primer](https://img.shields.io/badge/UI-Primer-blue.svg)](https://primer.style/)

A public leaderboard tracking all-time commit contributions across GitHub. Connect your GitHub account to see where you rank among developers worldwide.

**Official Instance: [ghcommits.com](https://ghcommits.com)**

---

## Overview

GitHub Commits Leaderboard aggregates commit contribution data from connected GitHub accounts and ranks developers by their all-time commit count. The project uses GitHub's GraphQL API to fetch contribution data, including both public and private repository commits (with user consent).

### Features

- All-time commit tracking from GitHub account creation to present
- Public and private repository commit counting
- Organization contribution support
- Cursor-based paginated leaderboard (50 users per page)
- User search by GitHub username
- Public REST API with rate limiting
- Automatic score refresh every 3 days
- Built with GitHub's Primer design system

---

## Using the Official Leaderboard

The easiest way to participate is to use the official instance at **[ghcommits.com](https://ghcommits.com)**.

1. Visit [ghcommits.com](https://ghcommits.com)
2. Click "Connect GitHub"
3. Review the data access agreement
4. Authorize the application on GitHub
5. Grant access to organizations you want commits counted from
6. Your profile will appear on the leaderboard after processing

Your commit count is refreshed automatically every 3 days.

---

## Self-Hosting

While we encourage using the official instance at [ghcommits.com](https://ghcommits.com) to maintain a unified global leaderboard, you can host your own private instance for organizations, teams, or research purposes.

### Prerequisites

- Node.js 20+
- A [Neon](https://neon.tech) PostgreSQL database (free tier available)
- A [Cloudflare](https://cloudflare.com) account (for Workers deployment)
- A GitHub OAuth App

### Environment Variables

Create a `.env.local` file:

```env
DATABASE_URL=postgresql://user:password@host/database
GITHUB_CLIENT_ID=your_github_oauth_client_id
GITHUB_CLIENT_SECRET=your_github_oauth_client_secret
TOKEN_ENCRYPTION_KEY=32_byte_hex_string_for_aes_encryption
SESSION_SECRET=random_secret_for_session_signing
APP_URL=http://localhost:3000
CRON_SECRET=secret_for_manual_refresh_endpoint
```

### Local Development

```bash
# Install dependencies
npm install

# Run database migrations
node scripts/migrate.mjs

# Start development server (uses .env.local)
npm run dev
```

For local development with `wrangler dev` (testing the Worker locally), create a `.dev.vars` file:

```env
DATABASE_URL=postgresql://user:password@host/database
```

The application automatically uses `DATABASE_URL` when the Hyperdrive binding is not available.

### GitHub OAuth App Setup

1. Go to GitHub Settings > Developer settings > OAuth Apps
2. Create a new OAuth App
3. Set the callback URL to `https://yourdomain.com/api/oauth/callback`
4. Request scopes: `read:user read:org`
5. Copy the Client ID and Client Secret to your environment variables

### Production Deployment (Cloudflare Workers)

**Step 1:** Create a Hyperdrive configuration (this securely stores your database credentials with Cloudflare):

```bash
npx wrangler login
npx wrangler hyperdrive create neon-leaderboard --connection-string="postgres://USER:PASS@HOST/DB"
```

**Step 2:** Copy the returned Hyperdrive ID to `wrangler.jsonc` (replace `<YOUR_HYPERDRIVE_ID>`)

**Step 3:** Set secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CRON_SECRET
```

**Step 4:** Deploy:

```bash
npm run deploy
```

---

## API Documentation

Full API documentation is available at `/api` on any running instance. Available at [this link](https://ghcommits.com) for the official docs. 

### Endpoints

| Endpoint                | Description              | Rate Limit       |
| ----------------------- | ------------------------ | ---------------- |
| `GET /api/leaderboard`  | Paginated leaderboard    | 60/min, 1000/day |
| `GET /api/user/{login}` | Lookup user by username  | 20/min, 200/day  |
| `GET /api/rank/{n}`     | Get user at rank N       | 20/min, 200/day  |

### Example Response

```json
{
  "version": 8,
  "generatedAt": "2026-03-02T14:00:00.000Z",
  "startingRank": 1,
  "nextCursor": "eyJjb21taXRzIjoxMjM0LCJnaXRodWJJZCI6NDJ9",
  "data": [
    {
      "rank": 1,
      "githubId": 12345,
      "login": "octocat",
      "name": "The Octocat",
      "avatarUrl": "https://avatars.githubusercontent.com/u/12345",
      "profileUrl": "https://github.com/octocat",
      "allTimeCommits": 15234,
      "lastUpdatedAt": "2026-03-01T12:00:00.000Z"
    }
  ]
}
```

---

## Architecture

- **Frontend**: Next.js 15 with React 19, GitHub Primer UI components
- **Backend**: Next.js API routes running on Cloudflare Workers
- **Database**: PostgreSQL (Neon) with Hyperdrive connection pooling
- **Authentication**: GitHub OAuth with encrypted token storage
- **Scheduling**: Cloudflare Workers Cron Triggers for automatic refresh

### How Commit Counting Works

1. On first connection, the system computes all-time commits by querying GitHub's GraphQL API in yearly windows from account creation to present
2. Both `totalCommitContributions` (public) and `restrictedContributionsCount` (private) are summed
3. Subsequent refreshes only query the delta since the last check
4. Organization commits require explicit OAuth grant from the user

---

## Project Structure

```text
src/
  app/                  # Next.js App Router pages
    api/                # API routes and documentation page
    connect/            # OAuth consent page
  components/           # React components
  lib/                  # Core business logic
    db.ts               # Database operations
    github.ts           # GitHub API integration
    crypto.ts           # Token encryption
scripts/
  migrate.mjs           # Database migration runner
  refresh-user.ts       # Manual user refresh utility
db/
  migrations/           # SQL migration files
```

---

## Research Use

Anonymized, aggregate data from the official leaderboard may be used for research purposes. Individual contribution counts are public by nature of the leaderboard, but no personally identifiable information beyond public GitHub profile data is collected or shared.

If you are a researcher interested in collaboration, please open an issue.

---

## Contributing

Contributions are welcome. Please read the [Contributing Guidelines](CONTRIBUTING.md) before submitting a pull request.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

## Security

For security concerns, please review our [Security Policy](SECURITY.md) and report vulnerabilities responsibly.
