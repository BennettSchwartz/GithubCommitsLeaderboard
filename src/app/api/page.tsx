"use client";

import { Heading, Link as PrimerLink, Text, PageLayout } from "@primer/react";
import { Stack } from "@primer/react/experimental";

const endpoints = [
  {
    method: "GET",
    path: "/api/leaderboard",
    query: "?limit=50&cursor=...",
    description: "Returns up to 50 public leaderboard rows, stable sorting metadata, and a cursor for the next page.",
    rateLimit: "60/min/IP, 1000/day/IP",
    params: [
      { name: "limit", type: "integer", description: "Number of rows, capped at 50" },
      { name: "cursor", type: "string", description: "Opaque base64 cursor from previous page" },
    ],
    response: ["version", "generatedAt", "startingRank", "nextCursor", "data[]"],
  },
  {
    method: "GET",
    path: "/api/user/{login}",
    query: "",
    description: "Looks up a connected GitHub login, returning rank and public profile fields when found.",
    rateLimit: "20/min/IP, 200/day/IP",
    params: [
      { name: "login", type: "string", description: "GitHub username, case-insensitive, leading @ ignored" },
    ],
    response: ["version", "generatedAt", "found", "data"],
  },
  {
    method: "GET",
    path: "/api/rank/{n}",
    query: "",
    description: "Returns the user currently occupying rank n using the canonical leaderboard ordering.",
    rateLimit: "20/min/IP, 200/day/IP",
    params: [
      { name: "n", type: "integer", description: "Positive integer rank" },
    ],
    response: ["version", "generatedAt", "found", "data"],
  },
  {
    method: "GET",
    path: "/api/badge/{login}",
    query: "?theme=light",
    description: "Returns an SVG badge showing the user's rank. Unregistered users get a prompt to join. Embed in READMEs or websites. Append .svg to the login for explicit file extension (optional).",
    rateLimit: "20/min/IP, 200/day/IP",
    params: [
      { name: "login", type: "string", description: "GitHub username, case-insensitive, leading @ ignored. .svg extension is optional." },
      { name: "theme", type: "string", description: '"light" (default) or "dark"' },
    ],
    response: ["SVG image (Content-Type: image/svg+xml)"],
  },
];

function EndpointCard({ endpoint }: { endpoint: typeof endpoints[0] }) {
  return (
    <div
      style={{
        padding: "var(--base-size-16)",
        border: "var(--borderWidth-thin) solid var(--borderColor-default)",
        borderRadius: "var(--borderRadius-medium)",
        backgroundColor: "var(--bgColor-muted)",
      }}
    >
      <Stack direction="vertical" gap="condensed">
        <Stack direction="horizontal" gap="condensed" align="center">
          <span
            style={{
              padding: "var(--base-size-4) var(--base-size-8)",
              backgroundColor: "var(--bgColor-accent-muted)",
              color: "var(--fgColor-accent)",
              borderRadius: "var(--borderRadius-small)",
              fontWeight: 600,
              fontSize: "var(--text-body-size-small)",
              fontFamily: "var(--fontStack-monospace)",
            }}
          >
            {endpoint.method}
          </span>
          <Text
            style={{
              fontFamily: "var(--fontStack-monospace)",
              fontSize: "var(--text-body-size-small)",
            }}
          >
            {endpoint.path}
            {endpoint.query && (
              <span style={{ color: "var(--fgColor-muted)" }}>{endpoint.query}</span>
            )}
          </Text>
        </Stack>

        <Text size="small">{endpoint.description}</Text>

        <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
          Rate limit: {endpoint.rateLimit}
        </Text>

        <div>
          <Text size="small" weight="semibold">Parameters</Text>
          <ul style={{ margin: "var(--base-size-4) 0", paddingLeft: "var(--base-size-20)" }}>
            {endpoint.params.map((param) => (
              <li key={param.name} style={{ fontSize: "var(--text-body-size-small)" }}>
                <code style={{ color: "var(--fgColor-accent)" }}>{param.name}</code>
                <span style={{ color: "var(--fgColor-muted)" }}> ({param.type})</span>
                {" — "}{param.description}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <Text size="small" weight="semibold">Response fields</Text>
          <Text
            size="small"
            style={{
              fontFamily: "var(--fontStack-monospace)",
              color: "var(--fgColor-muted)",
              display: "block",
              marginTop: "var(--base-size-4)",
            }}
          >
            {endpoint.response.join(", ")}
          </Text>
        </div>
      </Stack>
    </div>
  );
}

export default function ApiDocsPage() {
  return (
    <PageLayout containerWidth="xlarge" padding="normal">
      <PageLayout.Header>
        <Stack direction="vertical" gap="normal" padding="normal" align="center">
          <Heading as="h1" style={{ textAlign: "center" }}>Public API</Heading>
          <Text size="medium" style={{ textAlign: "center", maxWidth: "600px" }}>
            Read-only endpoints for the leaderboard. All public GET endpoints are cache-friendly,
            DB-backed, and protected by IP-based rate limits.
          </Text>
          <PrimerLink href="/">← Back to leaderboard</PrimerLink>
        </Stack>
      </PageLayout.Header>

      <PageLayout.Content>
        <Stack direction="vertical" gap="normal" padding="normal">
          <Heading as="h2">Endpoints</Heading>
          <Stack direction="vertical" gap="normal">
            {endpoints.map((endpoint) => (
              <EndpointCard key={endpoint.path} endpoint={endpoint} />
            ))}
          </Stack>

          <Heading as="h2">Example Response</Heading>
          <pre
            style={{
              padding: "var(--base-size-16)",
              backgroundColor: "var(--bgColor-muted)",
              border: "var(--borderWidth-thin) solid var(--borderColor-default)",
              borderRadius: "var(--borderRadius-medium)",
              overflow: "auto",
              fontFamily: "var(--fontStack-monospace)",
              fontSize: "var(--text-body-size-small)",
            }}
          >
{`GET /api/leaderboard?limit=2

{
  "version": 8,
  "generatedAt": "2026-03-02T14:00:00.000Z",
  "startingRank": 1,
  "nextCursor": "eyJjb21taXRzIjoxMjM0LCJnaXRodWJJZCI6NDJ9",
  "data": [
    {
      "githubId": 12345,
      "login": "octocat",
      "name": "The Octocat",
      "avatarUrl": "https://avatars.githubusercontent.com/u/12345",
      "profileUrl": "https://github.com/octocat",
      "githubCreatedAt": "2011-01-25T18:44:36Z",
      "allTimeCommits": 15234,
      "lastUpdatedAt": "2026-03-01T12:00:00.000Z"
    }
  ]
}`}
          </pre>

          <Heading as="h2">Notes</Heading>
          <ul style={{ paddingLeft: "var(--base-size-20)", lineHeight: 1.6 }}>
            <li>The leaderboard is sorted by commits descending, then by numeric GitHub user ID ascending.</li>
            <li>Login lookups are case-insensitive and normalize away a leading @ symbol.</li>
            <li>Public GET routes return cache headers suitable for Cloudflare edge caching.</li>
            <li>OAuth and session routes are never cached.</li>
            <li>
              Source code is available from the repository link on the{" "}
              <PrimerLink href="/">homepage</PrimerLink>.
            </li>
          </ul>
        </Stack>
      </PageLayout.Content>
    </PageLayout>
  );
}
