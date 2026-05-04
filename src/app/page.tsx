"use client";

import { CheckCircleFillIcon, AlertIcon, MarkGithubIcon } from "@primer/octicons-react";
import { Button, Flash, Heading, PageLayout, Spinner, Text } from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { BadgeSection } from "@/components/badge-section";
import { LeaderboardClient } from "@/components/leaderboard-client";
import { SearchPanel } from "@/components/search-panel";
import { TimeBasedLeaderboard } from "@/components/time-based-leaderboard";
import type { LeaderboardResponse } from "@/lib/types";

const REPO_URL = process.env.NEXT_PUBLIC_REPOSITORY_URL ?? "https://github.com/your-org/GithubCommitsLeaderboard";

function getStatusMessage(errorCode: string | null, connected: string | null) {
  if (connected === "1") {
    return {
      variant: "success" as const,
      title: "GitHub account connected",
      body: "Your profile was stored and a leaderboard refresh was started for this account.",
      icon: <CheckCircleFillIcon size={16} />, 
    };
  }

  if (errorCode === "oauth_state") {
    return {
      variant: "danger" as const,
      title: "OAuth validation failed",
      body: "The GitHub callback state was invalid or expired. Start the connect flow again.",
      icon: <AlertIcon size={16} />, 
    };
  }

  if (errorCode === "oauth_callback") {
    return {
      variant: "danger" as const,
      title: "GitHub login failed",
      body: "The OAuth callback completed but user setup or score refresh failed.",
      icon: <AlertIcon size={16} />, 
    };
  }

  return null;
}

type LeaderboardTab = "all-time" | "time-based";

function HomeContent() {
  const searchParams = useSearchParams();
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("all-time");

  const status = getStatusMessage(
    searchParams.get("error"),
    searchParams.get("connected"),
  );

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const response = await fetch("/api/leaderboard?limit=50");
        if (!response.ok) {
          throw new Error(`Failed to fetch leaderboard: ${response.status}`);
        }
        const data = await response.json();
        setLeaderboard(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load leaderboard");
      } finally {
        setIsLoading(false);
      }
    }

    async function fetchStats() {
      try {
        const response = await fetch("/api/stats");
        if (!response.ok) return;
        const data = (await response.json()) as { totalUsers: number };
        setTotalUsers(data.totalUsers);
      } catch {
        // non-critical; leave totalUsers null so the caption falls back gracefully
      }
    }

    fetchLeaderboard();
    fetchStats();
  }, []);

  return (
    <PageLayout containerWidth="xlarge" padding="normal">
      <PageLayout.Header>
        <Stack direction="vertical" gap="normal" padding="normal" align="center">
          {status && (
            <Flash variant={status.variant} full>
              <Stack direction="horizontal" gap="condensed" align="center">
                {status.icon}
                <Text weight="semibold">{status.title}</Text>
              </Stack>
              <Text>{status.body}</Text>
            </Flash>
          )}
          <Heading as="h1" style={{ textAlign: "center" }}>All Time GitHub Commits</Heading>
          <Text size="medium" style={{ textAlign: "center", maxWidth: "600px" }}>
            A public leaderboard tracking all-time commit contributions across GitHub.
            Connect your account to see where you rank among developers worldwide.
          </Text>
          <Text size="medium" style={{ textAlign: "center" }}>
            Made by <a href="https://github.com/BennettSchwartz" target="_blank" rel="noopener noreferrer" style={{ color: "var(--fgColor-accent)", textDecoration: "none" }}>Bennett Schwartz</a>
          </Text>
          <Stack direction="horizontal" gap="normal" wrap="wrap" justify="center">
            <Button as="a" href="/connect" variant="primary">
              Connect GitHub
            </Button>
            <Button as="a" href={REPO_URL}>
              <MarkGithubIcon size={16} /> Repository
            </Button>
            <Button as="a" href="/compare">
              Compare
            </Button>
            <Button as="a" href="/api">
              API Docs
            </Button>
          </Stack>
          {totalUsers !== null && totalUsers > 0 && (
            <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
              {totalUsers} developers on the leaderboard
            </Text>
          )}
        </Stack>
      </PageLayout.Header>
      <PageLayout.Content>
        <Stack direction="vertical" gap="normal" padding="normal" align="center">
          <div className="badge-search-row" style={{ display: "grid", gridTemplateColumns: "1fr", gap: "var(--base-size-16)", width: "100%" }}>
            <BadgeSection />
            <SearchPanel />
          </div>
          <Stack direction="vertical" gap="condensed" style={{ width: "100%" }}>
            <Heading as="h2" style={{ textAlign: "center" }}>Public Leaderboard</Heading>
            <Stack direction="horizontal" gap="none" justify="center">
              {(["all-time", "time-based"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    padding: "var(--base-size-8) var(--base-size-16)",
                    border: "var(--borderWidth-thin) solid var(--borderColor-default)",
                    backgroundColor:
                      activeTab === tab ? "var(--bgColor-accent-muted)" : "var(--bgColor-default)",
                    color: activeTab === tab ? "var(--fgColor-accent)" : "var(--fgColor-muted)",
                    fontSize: "var(--text-body-size-small)",
                    fontWeight: activeTab === tab ? 600 : 400,
                    cursor: "pointer",
                    borderRadius: 0,
                    ...(tab === "all-time"
                      ? { borderTopLeftRadius: "var(--borderRadius-medium)", borderBottomLeftRadius: "var(--borderRadius-medium)" }
                      : { borderTopRightRadius: "var(--borderRadius-medium)", borderBottomRightRadius: "var(--borderRadius-medium)" }),
                  }}
                >
                  {tab === "all-time" ? "All Time" : "Recent Activity"}
                </button>
              ))}
            </Stack>

            {activeTab === "all-time" ? (
              <>
                <Text size="small" weight="light" style={{ textAlign: "center" }}>
                  Sorted by all-time commits descending
                </Text>
                {isLoading ? (
                  <Stack direction="horizontal" gap="condensed" align="center" justify="center" padding="spacious">
                    <Spinner size="medium" />
                    <Text>Loading leaderboard...</Text>
                  </Stack>
                ) : error ? (
                  <Flash variant="danger">{error}</Flash>
                ) : leaderboard ? (
                  <LeaderboardClient initialPage={leaderboard} />
                ) : null}
              </>
            ) : (
              <>
                <Text size="small" weight="light" style={{ textAlign: "center" }}>
                  Ranked by commits gained in the selected period
                </Text>
                <TimeBasedLeaderboard />
              </>
            )}
          </Stack>
        </Stack>
      </PageLayout.Content>
      <style>{`
        @media (min-width: 768px) {
          .badge-search-row {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </PageLayout>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={
      <Stack direction="horizontal" gap="condensed" align="center" justify="center" padding="spacious">
        <Spinner size="medium" />
        <Text>Loading...</Text>
      </Stack>
    }>
      <HomeContent />
    </Suspense>
  );
}
