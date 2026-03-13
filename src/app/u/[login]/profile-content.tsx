"use client";

import { CheckIcon, CopyIcon, LinkIcon, ShareIcon } from "@primer/octicons-react";
import {
  Avatar,
  Button,
  Heading,
  Link as PrimerLink,
  PageLayout,
  Text,
} from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useEffect, useState } from "react";

import { JoinBanner } from "@/components/join-banner";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      size="small"
      leadingVisual={copied ? CheckIcon : CopyIcon}
      onClick={handleCopy}
      aria-label="Copy to clipboard"
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <Stack direction="vertical" gap="condensed">
      <Text size="small" weight="medium">
        {label}
      </Text>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "var(--base-size-8)",
        }}
      >
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: "var(--base-size-8)",
            border: "var(--borderWidth-thin) solid var(--borderColor-default)",
            borderRadius: "var(--borderRadius-medium)",
            backgroundColor: "var(--bgColor-default)",
            fontFamily: "var(--fontStack-monospace)",
            fontSize: "var(--text-body-size-small)",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {code}
        </pre>
        <CopyButton text={code} />
      </div>
    </Stack>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

type HistoryEntry = { allTimeCommits: number; recordedAt: string };

const PERIODS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
] as const;

function CommitHistory({ login, currentCommits }: { login: string; currentCommits: number }) {
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/user/${encodeURIComponent(login)}/history?days=${days}`)
      .then((r) => r.json())
      .then((data) => {
        setHistory(data.history ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [login, days]);

  const oldest = history.length > 0 ? history[0] : null;
  const commitDelta = oldest ? currentCommits - oldest.allTimeCommits : 0;

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "500px",
        padding: "var(--base-size-16)",
        border: "var(--borderWidth-thin) solid var(--borderColor-default)",
        borderRadius: "var(--borderRadius-medium)",
        backgroundColor: "var(--bgColor-muted)",
      }}
    >
      <Stack direction="vertical" gap="normal">
        <Stack direction="horizontal" gap="condensed" align="center" justify="space-between">
          <Text size="small" weight="semibold">Commit Growth</Text>
          <Stack direction="horizontal" gap="none">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                style={{
                  padding: "var(--base-size-4) var(--base-size-8)",
                  border: "var(--borderWidth-thin) solid var(--borderColor-default)",
                  backgroundColor:
                    days === p.days
                      ? "var(--bgColor-accent-muted)"
                      : "var(--bgColor-default)",
                  color:
                    days === p.days
                      ? "var(--fgColor-accent)"
                      : "var(--fgColor-muted)",
                  fontSize: "var(--text-body-size-small)",
                  cursor: "pointer",
                  borderRadius: 0,
                  ...(p.days === PERIODS[0].days
                    ? { borderTopLeftRadius: "var(--borderRadius-small)", borderBottomLeftRadius: "var(--borderRadius-small)" }
                    : p.days === PERIODS[PERIODS.length - 1].days
                      ? { borderTopRightRadius: "var(--borderRadius-small)", borderBottomRightRadius: "var(--borderRadius-small)" }
                      : {}),
                }}
              >
                {p.label}
              </button>
            ))}
          </Stack>
        </Stack>

        {loading ? (
          <Text size="small" style={{ color: "var(--fgColor-muted)", textAlign: "center" }}>
            Loading...
          </Text>
        ) : history.length === 0 ? (
          <Text size="small" style={{ color: "var(--fgColor-muted)", textAlign: "center" }}>
            No history data yet for this period.
          </Text>
        ) : (
          <>
            {/* Simple bar visualization */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 60 }}>
              {history.map((entry, i) => {
                const min = history.reduce((m, e) => Math.min(m, e.allTimeCommits), Infinity);
                const max = Math.max(currentCommits, history.reduce((m, e) => Math.max(m, e.allTimeCommits), 0));
                const range = max - min || 1;
                const height = Math.max(4, ((entry.allTimeCommits - min) / range) * 56);
                return (
                  <div
                    key={i}
                    title={`${entry.allTimeCommits.toLocaleString()} commits — ${formatDate(entry.recordedAt)}`}
                    style={{
                      flex: 1,
                      height,
                      backgroundColor: "var(--fgColor-accent)",
                      borderRadius: 2,
                      opacity: 0.6 + (i / history.length) * 0.4,
                    }}
                  />
                );
              })}
            </div>

            <Stack direction="horizontal" gap="spacious" justify="center">
              <Stack direction="vertical" gap="none" align="center">
                <Text size="small" weight="light">Commits added</Text>
                <Text
                  size="large"
                  weight="semibold"
                  style={{
                    color: commitDelta > 0 ? "#238636" : "var(--fgColor-muted)",
                  }}
                >
                  {commitDelta > 0 ? "+" : ""}
                  {commitDelta.toLocaleString()}
                </Text>
              </Stack>
              <Stack direction="vertical" gap="none" align="center">
                <Text size="small" weight="light">Data points</Text>
                <Text size="large" weight="semibold">
                  {history.length}
                </Text>
              </Stack>
            </Stack>
          </>
        )}
      </Stack>
    </div>
  );
}

function ShareButtons({
  siteUrl,
  login,
  displayName,
  rank,
  percentile,
}: {
  siteUrl: string;
  login: string;
  displayName: string;
  rank: number;
  percentile: number;
}) {
  const [linkCopied, setLinkCopied] = useState(false);
  const profileUrl = `${siteUrl}/u/${login}`;
  const tweetText = `I'm ranked #${rank} (Top ${percentile}%) on the GitHub Commits Leaderboard! ${profileUrl}`;
  const twitterUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  async function handleCopyLink() {
    await navigator.clipboard.writeText(profileUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  return (
    <Stack direction="horizontal" gap="condensed">
      <Button
        as="a"
        href={twitterUrl}
        target="_blank"
        rel="noreferrer"
        leadingVisual={ShareIcon}
        size="small"
      >
        Share on X
      </Button>
      <Button
        leadingVisual={linkCopied ? CheckIcon : LinkIcon}
        size="small"
        onClick={handleCopyLink}
      >
        {linkCopied ? "Copied!" : "Copy link"}
      </Button>
    </Stack>
  );
}

type ProfileFoundProps = {
  found: true;
  siteUrl: string;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  rank: number;
  percentile: number;
  allTimeCommits: number;
  githubCreatedAt: string;
};

type ProfileNotFoundProps = {
  found: false;
  siteUrl: string;
};

type ProfileContentProps = ProfileFoundProps | ProfileNotFoundProps;

export function ProfileContent(props: ProfileContentProps) {
  if (!props.found) {
    return (
      <PageLayout containerWidth="medium" padding="normal">
        <PageLayout.Content>
          <Stack direction="vertical" gap="spacious" padding="spacious" align="center">
            <JoinBanner />
            <Heading as="h1">User Not Found</Heading>
            <Text size="medium" style={{ color: "var(--fgColor-muted)" }}>
              This user hasn&apos;t joined the leaderboard yet.
            </Text>
            <PrimerLink href="/">← Back to leaderboard</PrimerLink>
          </Stack>
        </PageLayout.Content>
      </PageLayout>
    );
  }

  const displayName = props.name ?? props.login;

  return (
    <PageLayout containerWidth="medium" padding="normal">
      <PageLayout.Content>
        <Stack direction="vertical" gap="spacious" padding="spacious" align="center">
          <JoinBanner />
          <Avatar src={props.avatarUrl} alt={`${props.login} avatar`} size={96} />

          <Stack direction="vertical" gap="condensed" align="center">
            <Heading as="h1" style={{ textAlign: "center" }}>
              {displayName}
            </Heading>
            <Text size="medium" style={{ color: "var(--fgColor-muted)" }}>
              @{props.login}
            </Text>
          </Stack>

          <Stack direction="vertical" gap="condensed" align="center">
            <Heading
              as="h2"
              style={{
                textAlign: "center",
                fontSize: "var(--text-display-size)",
                color: "var(--fgColor-accent)",
              }}
            >
              Rank #{props.rank}
            </Heading>
            <Text size="large" style={{ textAlign: "center" }}>
              Top {props.percentile}% by GitHub commits
            </Text>
          </Stack>

          <Stack direction="horizontal" gap="spacious" wrap="wrap" justify="center">
            <Stack direction="vertical" gap="none" align="center">
              <Text size="small" weight="light">All-time commits</Text>
              <Text size="large" weight="semibold">
                {props.allTimeCommits.toLocaleString()}
              </Text>
            </Stack>
            <Stack direction="vertical" gap="none" align="center">
              <Text size="small" weight="light">GitHub member since</Text>
              <Text size="large" weight="semibold">
                {formatDate(props.githubCreatedAt)}
              </Text>
            </Stack>
          </Stack>

          <PrimerLink href={props.profileUrl} target="_blank" rel="noreferrer">
            View on GitHub
          </PrimerLink>

          <ShareButtons
            siteUrl={props.siteUrl}
            login={props.login}
            displayName={displayName}
            rank={props.rank}
            percentile={props.percentile}
          />

          <CommitHistory login={props.login} currentCommits={props.allTimeCommits} />

          <div
            style={{
              width: "100%",
              maxWidth: "500px",
              height: "var(--borderWidth-thin)",
              backgroundColor: "var(--borderColor-default)",
            }}
          />

          <Stack
            direction="vertical"
            gap="normal"
            style={{ width: "100%", maxWidth: "500px" }}
          >
            <Stack direction="vertical" gap="condensed" align="center">
              <Heading
                as="h2"
                style={{
                  textAlign: "center",
                  fontSize: "var(--text-title-size-medium)",
                }}
              >
                Embed this badge
              </Heading>
            </Stack>

            <div
              style={{
                padding: "var(--base-size-12)",
                backgroundColor: "var(--bgColor-muted)",
                border: "var(--borderWidth-thin) solid var(--borderColor-default)",
                borderRadius: "var(--borderRadius-medium)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/badge/${props.login}.svg`}
                alt={`GitHub Commits Badge for ${props.login}`}
                height={28}
              />
            </div>

            <CodeBlock
              label="Markdown"
              code={`[![GitHub Commits Badge](${props.siteUrl}/api/badge/${props.login}.svg)](${props.siteUrl}/u/${props.login})`}
            />
            <CodeBlock
              label="HTML"
              code={`<a href="${props.siteUrl}/u/${props.login}"><img src="${props.siteUrl}/api/badge/${props.login}.svg" alt="GitHub Commits Badge" /></a>`}
            />
            <CodeBlock
              label="Image URL"
              code={`${props.siteUrl}/api/badge/${props.login}.svg`}
            />
          </Stack>

          <Stack direction="horizontal" gap="normal">
            <PrimerLink href="/compare">Compare with another developer</PrimerLink>
            <PrimerLink href="/">← Back to leaderboard</PrimerLink>
          </Stack>
        </Stack>
      </PageLayout.Content>
    </PageLayout>
  );
}
