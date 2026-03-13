"use client";

import { CheckIcon, CopyIcon } from "@primer/octicons-react";
import {
  Button,
  Flash,
  Heading,
  Link as PrimerLink,
  PageLayout,
  Spinner,
  Text,
} from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const BASE_URL = "https://ghcommits.com";

type Phase = "processing" | "complete" | "error";

interface Progress {
  window: number;
  total: number;
  commitsSoFar: number;
  yearLabel: string;
}

interface Result {
  rank: number;
  percentile: number;
  totalCommits: number;
  login: string;
}

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

export default function OnboardingPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("processing");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    async function runOnboarding() {
      const response = await fetch("/api/onboarding/refresh", {
        method: "POST",
      });

      if (!response.ok || !response.body) {
        if (response.status === 401) {
          router.push("/");
          return;
        }
        setErrorMessage("Failed to start commit counting. Please try again.");
        setPhase("error");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const event = JSON.parse(line.slice(6));
            if (event.type === "progress") setProgress(event);
            else if (event.type === "complete") {
              setResult(event);
              setPhase("complete");
            } else if (event.type === "error") {
              setErrorMessage(event.message);
              setPhase("error");
            }
          }
        }
      }
    }

    runOnboarding();
  }, [router]);

  return (
    <PageLayout containerWidth="medium" padding="normal">
      <PageLayout.Content>
        <Stack direction="vertical" gap="spacious" padding="spacious" align="center">
          {phase === "processing" && (
            <>
              <Stack direction="vertical" gap="normal" align="center">
                <Heading as="h1" style={{ textAlign: "center" }}>
                  Counting Your Commits
                </Heading>
                {progress ? (
                  <Text
                    size="medium"
                    style={{ textAlign: "center", color: "var(--fgColor-muted)" }}
                  >
                    Processing {progress.yearLabel}...
                  </Text>
                ) : (
                  <Spinner size="medium" />
                )}
              </Stack>

              <div style={{ width: "100%", maxWidth: "500px" }}>
                <div
                  style={{
                    width: "100%",
                    height: 8,
                    backgroundColor: "var(--bgColor-neutral-muted)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  {progress && (
                    <div
                      style={{
                        width: `${(progress.window / progress.total) * 100}%`,
                        height: "100%",
                        backgroundColor: "#238636",
                        borderRadius: 4,
                        transition: "width 0.3s ease",
                      }}
                    />
                  )}
                </div>
              </div>

              {progress && (
                <Text size="medium" style={{ color: "var(--fgColor-muted)" }}>
                  {progress.commitsSoFar.toLocaleString()} commits counted
                </Text>
              )}
            </>
          )}

          {phase === "complete" && result && (
            <>
              <Stack direction="vertical" gap="normal" align="center">
                <Heading as="h1" style={{ textAlign: "center" }}>
                  You&apos;re on the Leaderboard!
                </Heading>
                <Heading
                  as="h2"
                  style={{
                    textAlign: "center",
                    fontSize: "var(--text-display-size)",
                    color: "var(--fgColor-accent)",
                  }}
                >
                  Rank #{result.rank}
                </Heading>
                <Text size="large" style={{ textAlign: "center" }}>
                  Top {result.percentile}% by GitHub commits
                </Text>
                <Text
                  size="medium"
                  style={{ textAlign: "center", color: "var(--fgColor-muted)" }}
                >
                  {result.totalCommits.toLocaleString()} all-time commits
                </Text>
              </Stack>

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
                    Add this badge to your README — show off your rank
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
                    src={`/api/badge/${result.login}.svg`}
                    alt={`GitHub Commits Badge for ${result.login}`}
                    height={28}
                  />
                </div>

                <CodeBlock
                  label="Markdown"
                  code={`[![GitHub Commits Badge](${BASE_URL}/api/badge/${result.login}.svg)](${BASE_URL})`}
                />
                <CodeBlock
                  label="HTML"
                  code={`<a href="${BASE_URL}"><img src="${BASE_URL}/api/badge/${result.login}.svg" alt="GitHub Commits Badge" /></a>`}
                />
                <CodeBlock
                  label="Image URL"
                  code={`${BASE_URL}/api/badge/${result.login}.svg`}
                />
              </Stack>

              <Stack direction="horizontal" gap="normal">
                <PrimerLink href={`/u/${result.login}`}>View your profile →</PrimerLink>
                <PrimerLink href="/">← Back to leaderboard</PrimerLink>
              </Stack>
            </>
          )}

          {phase === "error" && (
            <>
              <Flash variant="danger" style={{ width: "100%", maxWidth: "500px" }}>
                {errorMessage ?? "An unexpected error occurred."}
              </Flash>
              <PrimerLink href="/">← Back to leaderboard</PrimerLink>
            </>
          )}
        </Stack>
      </PageLayout.Content>
    </PageLayout>
  );
}
