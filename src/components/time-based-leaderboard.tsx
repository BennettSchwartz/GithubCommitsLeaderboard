"use client";

import { Avatar, Flash, Link as PrimerLink, Spinner, Text } from "@primer/react";
import { DataTable, Stack } from "@primer/react/experimental";
import type { Column } from "@primer/react/experimental";
import { useEffect, useState } from "react";

import type { LeaderboardEntry } from "@/lib/types";

type TimeBasedEntry = LeaderboardEntry & { commitsDelta: number };
type TimeBasedRow = TimeBasedEntry & { id: number };

const PERIODS = [
  { label: "90 days", days: 90 },
  { label: "6 months", days: 180 },
  { label: "1 year", days: 365 },
] as const;

export function TimeBasedLeaderboard() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<TimeBasedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/leaderboard/time-based?days=${days}&limit=50`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return r.json();
      })
      .then((result) => {
        setData(result.data ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load");
        setLoading(false);
      });
  }, [days]);

  const rows: TimeBasedRow[] = data.map((entry) => ({
    ...entry,
    id: entry.githubId,
  }));

  const columns: Column<TimeBasedRow>[] = [
    {
      header: "#",
      field: "rank",
      width: "auto",
      renderCell: (row) => (
        <Text weight="semibold">#{row.rank}</Text>
      ),
    },
    {
      header: "Developer",
      field: "login",
      rowHeader: true,
      renderCell: (row) => (
        <PrimerLink href={`/u/${row.login}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Stack direction="horizontal" gap="condensed" align="center">
            <Avatar src={row.avatarUrl} alt={`${row.login} avatar`} size={32} />
            <Stack direction="vertical" gap="none">
              <Text weight="semibold">{row.name ?? row.login}</Text>
              <Text size="small" weight="light">@{row.login}</Text>
            </Stack>
          </Stack>
        </PrimerLink>
      ),
    },
    {
      header: "Commits gained",
      field: "commitsDelta",
      renderCell: (row) => (
        <Text weight="semibold" style={{ color: "#238636" }}>
          +{row.commitsDelta.toLocaleString()}
        </Text>
      ),
    },
    {
      header: "All-time total",
      field: "allTimeCommits",
      renderCell: (row) => (
        <Text>{row.allTimeCommits.toLocaleString()}</Text>
      ),
    },
  ];

  return (
    <Stack direction="vertical" gap="condensed">
      <Stack direction="horizontal" gap="none">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            style={{
              padding: "var(--base-size-4) var(--base-size-12)",
              border: "var(--borderWidth-thin) solid var(--borderColor-default)",
              backgroundColor:
                days === p.days ? "var(--bgColor-accent-muted)" : "var(--bgColor-default)",
              color: days === p.days ? "var(--fgColor-accent)" : "var(--fgColor-muted)",
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

      {loading ? (
        <Stack direction="horizontal" gap="condensed" align="center" justify="center" padding="spacious">
          <Spinner size="medium" />
          <Text>Loading...</Text>
        </Stack>
      ) : error ? (
        <Flash variant="danger">{error}</Flash>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: "var(--base-size-32)",
            textAlign: "center",
            border: "var(--borderWidth-thin) solid var(--borderColor-default)",
            borderRadius: "var(--borderRadius-medium)",
            backgroundColor: "var(--bgColor-muted)",
          }}
        >
          <Text style={{ color: "var(--fgColor-muted)" }}>
            No data yet for this period. History starts recording after the next refresh cycle.
          </Text>
        </div>
      ) : (
        <DataTable
          aria-label="Time-based commits leaderboard"
          data={rows}
          columns={columns}
          cellPadding="spacious"
        />
      )}
    </Stack>
  );
}
