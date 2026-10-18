import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui";
import { MusicIcon } from "@/components/icons";
import { listTracks, MUSIC_PAGE_SIZE_DEFAULT } from "@/server/services/music";
import { MusicLibrary } from "./MusicLibrary";

export const metadata: Metadata = { title: "Music" };
export const dynamic = "force-dynamic";

/**
 * DEX Music library.
 *
 * A rights-first surface: the list is served by the music service (PUBLIC,
 * non-deleted tracks only) and the first page is rendered on the server. There
 * is no catalogue to ship — no copyrighted audio is bundled — so when nothing
 * is playable the page says exactly why and what makes a track eligible, rather
 * than showing an invented row.
 */
export default async function MusicPage() {
  const page = await listTracks({ limit: MUSIC_PAGE_SIZE_DEFAULT });

  return (
    <div className="px-4 py-5 sm:px-6">
      <PageHeader
        eyebrow="Audio"
        title="DEX Music"
        description="Rights-cleared audio: every track shows its licence, attribution and territory, and downloads only where the rights allow."
        className="mb-6"
      />

      {page.items.length === 0 ? (
        <EmptyState
          icon={<MusicIcon size={20} />}
          title="No music yet"
          description={
            <>
              DEX Music plays audio whose rights are recorded. A track only becomes playable once it
              has a stored audio file <em>and</em> complete rights metadata — its source, licence,
              the exact attribution line, the territory where distribution is permitted, and whether
              downloads are allowed. No music ships with DEXTube and there is no web upload form for
              audio yet, so tracks are added by the seed script or directly by the operator
              (<code>scripts/make-test-audio.ts</code> and <code>prisma/seed.ts</code> show the
              format). The first rights-cleared track will appear here.
            </>
          }
        />
      ) : (
        <MusicLibrary initialTracks={page.items} initialNextOffset={page.nextOffset} />
      )}
    </div>
  );
}
