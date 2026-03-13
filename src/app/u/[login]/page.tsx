import type { Metadata } from "next";

import { findUserByLoginWithCount } from "@/lib/db";
import { siteUrl, siteName } from "@/app/seo";
import { ProfileContent } from "./profile-content";

type Props = {
  params: Promise<{ login: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { login } = await params;
  const result = await findUserByLoginWithCount(login);

  if (!result.found || !result.data) {
    return {
      title: "User Not Found | GitHub Commits Leaderboard",
    };
  }

  const { data, totalUsers } = result;
  const percentile = Math.max(
    1,
    Math.ceil((1 - (data.rank - 1) / totalUsers) * 100),
  );
  const name = data.name ?? data.login;

  return {
    title: `${name} — Rank #${data.rank} | GitHub Commits Leaderboard`,
    description: `${name} is ranked #${data.rank} (Top ${percentile}%) with ${data.allTimeCommits.toLocaleString()} all-time GitHub commits.`,
    openGraph: {
      title: `${name} — Rank #${data.rank} | GitHub Commits Leaderboard`,
      description: `${name} is ranked #${data.rank} (Top ${percentile}%) with ${data.allTimeCommits.toLocaleString()} all-time GitHub commits.`,
      url: `${siteUrl}/u/${data.login}`,
      siteName,
      type: "profile",
    },
  };
}

export default async function ProfilePage({ params }: Props) {
  const { login } = await params;
  const result = await findUserByLoginWithCount(login);

  if (!result.found || !result.data) {
    return <ProfileContent found={false} siteUrl={siteUrl} />;
  }

  const { data, totalUsers } = result;
  const percentile = Math.max(
    1,
    Math.ceil((1 - (data.rank - 1) / totalUsers) * 100),
  );

  return (
    <ProfileContent
      found={true}
      siteUrl={siteUrl}
      login={data.login}
      name={data.name}
      avatarUrl={data.avatarUrl}
      profileUrl={data.profileUrl}
      rank={data.rank}
      percentile={percentile}
      allTimeCommits={data.allTimeCommits}
      githubCreatedAt={data.githubCreatedAt}
    />
  );
}
