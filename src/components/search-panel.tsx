"use client";

import { SearchIcon } from "@primer/octicons-react";
import { Button, Flash, Heading, Spinner, Text, TextInput } from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useState } from "react";
import { useRouter } from "next/navigation";

import type { UserLookupResponse } from "@/lib/types";

export function SearchPanel() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      if (payload.found && payload.data) {
        router.push(`/u/${payload.data.login}`);
      } else {
        setError("No connected user matched that login.");
      }
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
        {error && <Flash variant="danger">{error}</Flash>}
      </Stack>
    </div>
  );
}
