"use client";

import { Button, Heading, Link as PrimerLink, PageLayout, Text } from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { JoinBanner } from "@/components/join-banner";

export default function CompareLandingPage() {
  const router = useRouter();
  const [inputA, setInputA] = useState("");
  const [inputB, setInputB] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const a = inputA.replace(/^@+/, "").trim();
    const b = inputB.replace(/^@+/, "").trim();
    if (a && b) {
      router.push(`/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
    }
  }

  const inputStyle = {
    padding: "var(--base-size-8) var(--base-size-12)",
    border: "var(--borderWidth-thin) solid var(--borderColor-default)",
    borderRadius: "var(--borderRadius-medium)",
    backgroundColor: "var(--bgColor-default)",
    color: "var(--fgColor-default)",
    fontFamily: "var(--fontStack-monospace)",
    fontSize: "var(--text-body-size-small)",
    width: 160,
  };

  return (
    <PageLayout containerWidth="medium" padding="normal">
      <PageLayout.Content>
        <Stack direction="vertical" gap="spacious" padding="spacious" align="center">
          <JoinBanner />
          <Heading as="h1" style={{ textAlign: "center" }}>
            Compare Developers
          </Heading>
          <Text size="medium" style={{ color: "var(--fgColor-muted)", textAlign: "center" }}>
            Enter two GitHub usernames to compare their commit rankings head to head.
          </Text>

          <form onSubmit={handleSubmit}>
            <Stack direction="horizontal" gap="condensed" align="center" wrap="wrap" justify="center">
              <input
                value={inputA}
                onChange={(e) => setInputA(e.target.value)}
                placeholder="@user1"
                aria-label="First username"
                style={inputStyle}
              />
              <Text weight="semibold">vs</Text>
              <input
                value={inputB}
                onChange={(e) => setInputB(e.target.value)}
                placeholder="@user2"
                aria-label="Second username"
                style={inputStyle}
              />
              <Button type="submit" variant="primary">
                Compare
              </Button>
            </Stack>
          </form>

          <PrimerLink href="/">← Back to leaderboard</PrimerLink>
        </Stack>
      </PageLayout.Content>
    </PageLayout>
  );
}
