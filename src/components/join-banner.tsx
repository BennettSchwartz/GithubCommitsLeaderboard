"use client";

import { Button, Text } from "@primer/react";
import { Stack } from "@primer/react/experimental";

export function JoinBanner() {
  return (
    <div
      style={{
        width: "100%",
        padding: "var(--base-size-12) var(--base-size-16)",
        backgroundColor: "var(--bgColor-accent-muted)",
        borderRadius: "var(--borderRadius-medium)",
        textAlign: "center",
      }}
    >
      <Stack direction="horizontal" gap="condensed" align="center" justify="center" wrap="wrap">
        <Text size="small">
          Want to see your own ranking?
        </Text>
        <Button as="a" href="/connect" variant="primary" size="small">
          Connect GitHub
        </Button>
      </Stack>
    </div>
  );
}
