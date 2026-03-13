"use client";

import { SearchIcon } from "@primer/octicons-react";
import { Button, Flash, Heading, Spinner, Text, TextInput } from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { startTransition, useDeferredValue, useState } from "react";

import type { UserLookupResponse } from "@/lib/types";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function SearchPanel() {
  const [login, setLogin] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<UserLookupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deferredLogin = useDeferredValue(login);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = login.replace(/^@+/, "").trim();

    if (!normalized) {
      setError("Enter a GitHub username to search.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/user/${encodeURIComponent(normalized)}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Lookup failed with ${response.status}`);
      }

      const payload = (await response.json()) as UserLookupResponse;

      startTransition(() => {
        setResult(payload);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Search failed");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div
      style={{
        padding: "var(--base-size-16)",
        border: "var(--borderWidth-thin) solid var(--borderColor-default)",
        borderRadius: "var(--borderRadius-medium)",
        backgroundColor: "var(--bgColor-muted)",
      }}
    >
      <Stack direction="vertical" gap="normal">
        <Heading as="h2">Find a Developer</Heading>
        <Text size="small" weight="light">
          Search for a GitHub login to see their rank and all-time commits.
        </Text>
        <form onSubmit={handleSubmit}>
          <Stack direction="horizontal" gap="condensed">
            <Stack.Item grow>
              <TextInput
                block
                value={login}
                onChange={(event) => setLogin(event.currentTarget.value)}
                leadingVisual={SearchIcon}
                placeholder="@octocat"
                aria-label="GitHub username"
              />
            </Stack.Item>
            <Button type="submit" variant="primary" disabled={isLoading}>
              {isLoading ? <Spinner size="small" /> : "Search"}
            </Button>
          </Stack>
        </form>
        <Text size="small" weight="light">
          Lookup target: {deferredLogin.trim() ? `@${deferredLogin.replace(/^@+/, "").trim()}` : "not set"}
        </Text>
        {error && <Flash variant="danger">{error}</Flash>}
        {result && (
          result.found && result.data ? (
            <div
              style={{
                padding: "var(--base-size-16)",
                border: "var(--borderWidth-thin) dashed var(--borderColor-default)",
                borderRadius: "var(--borderRadius-medium)",
                backgroundColor: "var(--bgColor-default)",
              }}
            >
              <Stack direction="vertical" gap="condensed">
                <Text size="small" weight="medium">
                  Rank #{result.data.rank}
                </Text>
                <Heading as="h3">
                  {result.data.name ?? result.data.login}
                </Heading>
                <Text size="small" weight="light">@{result.data.login}</Text>
                <Stack direction="horizontal" gap="spacious" wrap="wrap">
                  <Stack direction="vertical" gap="none">
                    <Text size="small" weight="light">All-time commits</Text>
                    <Text size="large" weight="semibold">
                      {result.data.allTimeCommits.toLocaleString()}
                    </Text>
                  </Stack>
                  <Stack direction="vertical" gap="none">
                    <Text size="small" weight="light">GitHub member since</Text>
                    <Text size="large" weight="semibold">
                      {formatDate(result.data.githubCreatedAt)}
                    </Text>
                  </Stack>
                </Stack>
                <Stack direction="vertical" gap="condensed">
                  <Text size="small" weight="semibold">Badge</Text>
                  <pre
                    style={{
                      padding: "var(--base-size-8) var(--base-size-12)",
                      backgroundColor: "var(--bgColor-muted)",
                      border: "var(--borderWidth-thin) solid var(--borderColor-default)",
                      borderRadius: "var(--borderRadius-medium)",
                      fontFamily: "var(--fontStack-monospace)",
                      fontSize: "var(--text-body-size-small)",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      margin: 0,
                    }}
                  >
                    {`[![GitHub Commits Badge](https://ghcommits.com/api/badge/${result.data.login}.svg)](https://ghcommits.com)`}
                  </pre>
                </Stack>
              </Stack>
            </div>
          ) : (
            <Flash variant="warning">No connected user matched that login.</Flash>
          )
        )}
      </Stack>
    </div>
  );
}
