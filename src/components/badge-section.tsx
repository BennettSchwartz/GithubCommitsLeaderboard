"use client";

import { AlertIcon, CheckIcon, CopyIcon, ImageIcon } from "@primer/octicons-react";
import { Button, Flash, Heading, Text, TextInput } from "@primer/react";
import { Stack } from "@primer/react/experimental";
import { useEffect, useRef, useState } from "react";

const BASE_URL = "https://ghcommits.com";

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

export function BadgeSection() {
  const [username, setUsername] = useState("");
  const [debouncedUsername, setDebouncedUsername] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const normalized = username.replace(/^@+/, "").trim();
  const debouncedNormalized = debouncedUsername.replace(/^@+/, "").trim();

  // Debounce: only update the preview after 500ms of no typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUsername(username);
      setRateLimited(false);
    }, 500);
    return () => clearTimeout(timer);
  }, [username]);

  // Detect 429 errors on the preview image
  useEffect(() => {
    if (!debouncedNormalized) return;

    const encoded = encodeURIComponent(debouncedNormalized);
    fetch(`/api/badge/${encoded}`, { method: "HEAD" }).then((res) => {
      if (res.status === 429) {
        setRateLimited(true);
      }
    }).catch(() => {
      // ignore network errors
    });
  }, [debouncedNormalized]);

  const encoded = encodeURIComponent(normalized);
  const badgeUrl = `${BASE_URL}/api/badge/${encoded}.svg`;

  const markdownCode = `[![GitHub Commits Badge](${badgeUrl})](${BASE_URL})`;
  const htmlCode = `<a href="${BASE_URL}"><img src="${badgeUrl}" alt="GitHub Commits Badge" /></a>`;

  const debouncedEncoded = encodeURIComponent(debouncedNormalized);
  const previewUrl = `/api/badge/${debouncedEncoded}`;

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
        <Heading as="h2">
          <Stack direction="horizontal" gap="condensed" align="center">
            <ImageIcon size={20} />
            Get Your Badge
          </Stack>
        </Heading>
        <Text size="small" weight="light">
          Enter your GitHub username to generate a badge you can embed in your README or website.
        </Text>
        <TextInput
          block
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
          leadingVisual={ImageIcon}
          placeholder="Enter your GitHub username"
          aria-label="GitHub username"
        />
        {normalized && (
          <Stack direction="vertical" gap="normal">
            {rateLimited && (
              <Flash variant="warning">
                <Stack direction="horizontal" gap="condensed" align="center">
                  <AlertIcon size={16} />
                  <Text>Too many requests. Wait a moment before previewing again.</Text>
                </Stack>
              </Flash>
            )}
            {debouncedNormalized && !rateLimited && (
              <Stack direction="vertical" gap="condensed">
                <Text size="small" weight="medium">Preview</Text>
                <div
                  style={{
                    padding: "var(--base-size-12)",
                    backgroundColor: "var(--bgColor-default)",
                    border: "var(--borderWidth-thin) solid var(--borderColor-default)",
                    borderRadius: "var(--borderRadius-medium)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={previewUrl}
                    alt={`GitHub Commits Badge for ${debouncedNormalized}`}
                    height={28}
                  />
                </div>
              </Stack>
            )}
            <CodeBlock label="Markdown" code={markdownCode} />
            <CodeBlock label="HTML" code={htmlCode} />
            <CodeBlock label="Image URL" code={badgeUrl} />
          </Stack>
        )}
      </Stack>
    </div>
  );
}
