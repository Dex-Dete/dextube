import type { Metadata } from "next";
import { PageHeader, SectionCard } from "@/components/ui";
import { getConfig } from "@/lib/config";
import { requireAdminPage } from "@/server/auth/admin";
import { importLimits, importStorageSummary, listImportSources } from "@/server/services/import-sources";
import { AdminImportClient } from "./AdminImportClient";

export const metadata: Metadata = { title: "Import" };
export const dynamic = "force-dynamic";

/**
 * Authorized import.
 *
 * The server component only gathers the initial state the client needs: the
 * current source list, the configured bounds, and whether a YouTube API key is
 * present (so the UI can state the public-feed limitation honestly instead of
 * pretending the connector can reach a whole channel).
 */
export default async function AdminImportPage() {
  // A page must never rely on its layout for its own access check: the layout
  // runs in parallel with the page, not before it.
  await requireAdminPage();
  const [sources, limits, storage] = await Promise.all([
    listImportSources({ take: 25 }),
    Promise.resolve(importLimits()),
    importStorageSummary(),
  ]);
  const youtubeApiKeyConfigured = Boolean(getConfig().imports.youtubeApiKey);

  return (
    <>
      <PageHeader
        title="Import"
        description="Migrate metadata from public channels or copy media only from an authorized creator export. Public YouTube imports intentionally stay metadata-only; the progress and storage panels show the real state."
      />

      <div className="mt-4 flex flex-col gap-5">
        <SectionCard
          title="New import"
          description="Preview first: nothing is written until you start the import."
        >
          <AdminImportClient
            initialSources={sources}
            initialStorage={storage}
            maxItems={limits.maxItems}
            maxConcurrency={limits.maxConcurrency}
            youtubeApiKeyConfigured={youtubeApiKeyConfigured}
          />
        </SectionCard>
      </div>
    </>
  );
}
