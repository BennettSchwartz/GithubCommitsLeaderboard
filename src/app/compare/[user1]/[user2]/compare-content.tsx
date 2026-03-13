"use client";

import { CheckIcon, CopyIcon, LinkIcon, ShareIcon } from "@primer/octicons-react";
import {
  Avatar,
  Button,
  Flash,
  Heading,
  Link as PrimerLink,
  PageLayout,
  Text,
} from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { JoinBanner } from "@/components/join-banner";

type UserData = {
  rank: number;
  percentile: number;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  profileUrl: string;
  githubCreatedAt: string;
  allTimeCommits: number;
  lastUpdatedAt: string | null;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function StatRow({
  label,
  valueA,
  valueB,
  highlightHigher = true,
}: {
  label: string;
  valueA: string;
  valueB: string;
  highlightHigher?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        gap: "var(--base-size-16)",
        alignItems: "center",
        padding: "var(--base-size-8) 0",
        borderBottom: "var(--borderWidth-thin) solid var(--borderColor-muted)",
      }}
    >
      <Text
        size="medium"
        weight={highlightHigher ? "semibold" : "normal"}
        style={{ textAlign: "center" }}
      >
        {valueA}
      </Text>
      <Text size="small" weight="light" style={{ color: "var(--fgColor-muted)" }}>
        {label}
      </Text>
      <Text
        size="medium"
        weight={highlightHigher ? "semibold" : "normal"}
        style={{ textAlign: "center" }}
      >
        {valueB}
      </Text>
    </div>
  );
}

function CommitBar({ userA, userB }: { userA: UserData; userB: UserData }) {
  const max = Math.max(userA.allTimeCommits, userB.allTimeCommits);
  const pctA = max > 0 ? (userA.allTimeCommits / max) * 100 : 0;
  const pctB = max > 0 ? (userB.allTimeCommits / max) * 100 : 0;

  return (
    <Stack direction="vertical" gap="condensed" style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--base-size-8)" }}>
        <Text size="small" weight="medium" style={{ width: 80, flexShrink: 0 }}>
          @{userA.login}
        </Text>
        <div
          style={{
            flex: 1,
            height: 24,
            backgroundColor: "var(--bgColor-neutral-muted)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pctA}%`,
              height: "100%",
              backgroundColor: "var(--fgColor-accent)",
              borderRadius: 4,
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <Text size="small" weight="semibold" style={{ width: 80, flexShrink: 0, textAlign: "right" }}>
          {userA.allTimeCommits.toLocaleString()}
        </Text>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--base-size-8)" }}>
        <Text size="small" weight="medium" style={{ width: 80, flexShrink: 0 }}>
          @{userB.login}
        </Text>
        <div
          style={{
            flex: 1,
            height: 24,
            backgroundColor: "var(--bgColor-neutral-muted)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pctB}%`,
              height: "100%",
              backgroundColor: "#238636",
              borderRadius: 4,
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <Text size="small" weight="semibold" style={{ width: 80, flexShrink: 0, textAlign: "right" }}>
          {userB.allTimeCommits.toLocaleString()}
        </Text>
      </div>
    </Stack>
  );
}

function CompareForm({ defaultA, defaultB }: { defaultA?: string; defaultB?: string }) {
  const router = useRouter();
  const [inputA, setInputA] = useState(defaultA ?? "");
  const [inputB, setInputB] = useState(defaultB ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const a = inputA.replace(/^@+/, "").trim();
    const b = inputB.replace(/^@+/, "").trim();
    if (a && b) {
      router.push(`/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap" justify="center">
        <input
          value={inputA}
          onChange={(e) => setInputA(e.target.value)}
          placeholder="@user1"
          aria-label="First username"
          style={{
            padding: "var(--base-size-8) var(--base-size-12)",
            border: "var(--borderWidth-thin) solid var(--borderColor-default)",
            borderRadius: "var(--borderRadius-medium)",
            backgroundColor: "var(--bgColor-default)",
            color: "var(--fgColor-default)",
            fontFamily: "var(--fontStack-monospace)",
            fontSize: "var(--text-body-size-small)",
            width: 140,
          }}
        />
        <Text weight="semibold">vs</Text>
        <input
          value={inputB}
          onChange={(e) => setInputB(e.target.value)}
          placeholder="@user2"
          aria-label="Second username"
          style={{
            padding: "var(--base-size-8) var(--base-size-12)",
            border: "var(--borderWidth-thin) solid var(--borderColor-default)",
            borderRadius: "var(--borderRadius-medium)",
            backgroundColor: "var(--bgColor-default)",
            color: "var(--fgColor-default)",
            fontFamily: "var(--fontStack-monospace)",
            fontSize: "var(--text-body-size-small)",
            width: 140,
          }}
        />
        <Button type="submit" variant="primary" size="small">
          Compare
        </Button>
      </Stack>
    </form>
  );
}

export function CompareContent({
  userA,
  userB,
  siteUrl,
}: {
  userA: UserData | null;
  userB: UserData | null;
  siteUrl: string;
}) {
  const [linkCopied, setLinkCopied] = useState(false);
  const bothFound = userA && userB;

  const compareUrl = bothFound
    ? `${siteUrl}/compare/${userA.login}/${userB.login}`
    : undefined;

  let tweetText = "";
  if (bothFound) {
    const nameA = userA.name ?? userA.login;
    const nameB = userB.name ?? userB.login;
    const diff = Math.abs(userA.allTimeCommits - userB.allTimeCommits);
    const ahead = userA.allTimeCommits >= userB.allTimeCommits ? nameA : nameB;
    tweetText = `${nameA} (#${userA.rank}) vs ${nameB} (#${userB.rank}) — ${ahead} is ${diff.toLocaleString()} commits ahead! ${compareUrl}`;
  }

  async function handleCopyLink() {
    if (!compareUrl) return;
    await navigator.clipboard.writeText(compareUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  return (
    <PageLayout containerWidth="large" padding="normal">
      <PageLayout.Content>
        <Stack direction="vertical" gap="spacious" padding="spacious" align="center">
          <JoinBanner />
          <Heading as="h1" style={{ textAlign: "center" }}>
            Compare Developers
          </Heading>

          <CompareForm
            defaultA={userA?.login ?? ""}
            defaultB={userB?.login ?? ""}
          />

          {(!userA || !userB) && (
            <Flash variant="warning" style={{ maxWidth: 500, width: "100%" }}>
              {!userA && !userB
                ? "Neither user was found on the leaderboard."
                : `@${!userA ? (userB?.login === undefined ? "user" : "user1") : (userA?.login === undefined ? "user" : "user2")} was not found on the leaderboard.`}
            </Flash>
          )}

          {bothFound && (
            <>
              {/* Avatars + VS */}
              <Stack direction="horizontal" gap="spacious" align="center" justify="center">
                <Stack direction="vertical" gap="condensed" align="center">
                  <PrimerLink href={`/u/${userA.login}`}>
                    <Avatar src={userA.avatarUrl} alt={`${userA.login} avatar`} size={80} />
                  </PrimerLink>
                  <PrimerLink href={`/u/${userA.login}`}>
                    <Text weight="semibold">{userA.name ?? userA.login}</Text>
                  </PrimerLink>
                  <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
                    @{userA.login}
                  </Text>
                </Stack>

                <Text
                  weight="semibold"
                  style={{
                    fontSize: "var(--text-title-size-large)",
                    color: "var(--fgColor-muted)",
                  }}
                >
                  vs
                </Text>

                <Stack direction="vertical" gap="condensed" align="center">
                  <PrimerLink href={`/u/${userB.login}`}>
                    <Avatar src={userB.avatarUrl} alt={`${userB.login} avatar`} size={80} />
                  </PrimerLink>
                  <PrimerLink href={`/u/${userB.login}`}>
                    <Text weight="semibold">{userB.name ?? userB.login}</Text>
                  </PrimerLink>
                  <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
                    @{userB.login}
                  </Text>
                </Stack>
              </Stack>

              {/* Difference callout */}
              {(() => {
                const diff = Math.abs(userA.allTimeCommits - userB.allTimeCommits);
                const rankDiff = Math.abs(userA.rank - userB.rank);
                const ahead =
                  userA.allTimeCommits >= userB.allTimeCommits
                    ? userA.name ?? userA.login
                    : userB.name ?? userB.login;
                return (
                  <div
                    style={{
                      padding: "var(--base-size-12) var(--base-size-16)",
                      backgroundColor: "var(--bgColor-accent-muted)",
                      borderRadius: "var(--borderRadius-medium)",
                      textAlign: "center",
                    }}
                  >
                    <Text size="medium" weight="semibold">
                      {diff === 0
                        ? "Tied on commits!"
                        : `${ahead} is ${diff.toLocaleString()} commits ahead`}
                    </Text>
                    {rankDiff > 0 && (
                      <Text
                        size="small"
                        style={{
                          display: "block",
                          marginTop: "var(--base-size-4)",
                          color: "var(--fgColor-muted)",
                        }}
                      >
                        {rankDiff.toLocaleString()} {rankDiff === 1 ? "rank" : "ranks"} apart
                      </Text>
                    )}
                  </div>
                );
              })()}

              {/* Commit bar chart */}
              <div style={{ width: "100%", maxWidth: 500 }}>
                <CommitBar userA={userA} userB={userB} />
              </div>

              {/* Stats comparison */}
              <div style={{ width: "100%", maxWidth: 500 }}>
                <StatRow label="Rank" valueA={`#${userA.rank}`} valueB={`#${userB.rank}`} />
                <StatRow
                  label="Percentile"
                  valueA={`Top ${userA.percentile}%`}
                  valueB={`Top ${userB.percentile}%`}
                />
                <StatRow
                  label="Commits"
                  valueA={userA.allTimeCommits.toLocaleString()}
                  valueB={userB.allTimeCommits.toLocaleString()}
                />
                <StatRow
                  label="Member since"
                  valueA={formatDate(userA.githubCreatedAt)}
                  valueB={formatDate(userB.githubCreatedAt)}
                  highlightHigher={false}
                />
              </div>

              {/* Share buttons */}
              <Stack direction="horizontal" gap="condensed">
                <Button
                  as="a"
                  href={`https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}`}
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
            </>
          )}

          <PrimerLink href="/">← Back to leaderboard</PrimerLink>
        </Stack>
      </PageLayout.Content>
    </PageLayout>
  );
}
