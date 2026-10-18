import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth/session";
import { getConfig } from "@/lib/config";
import { acceptedFormatsSummary } from "@/server/media/validate";
import { UploadForm } from "./UploadForm";

export const metadata: Metadata = { title: "Upload a video" };
export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/studio/upload");
  if (!user.channel) redirect("/studio/channel");

  const config = getConfig();

  return (
    <div className="px-4 py-6 sm:px-6">
      <nav className="mb-4 text-xs text-subtle" aria-label="Breadcrumb">
        <Link href="/studio" className="dt-link">
          Studio
        </Link>{" "}
        / Upload
      </nav>
      <h1 className="mb-1 text-xl font-bold">Upload a video</h1>
      <p className="mb-6 text-sm text-muted">
        Uploading to <strong>{user.channel.name}</strong>. Processing runs in the background; you can keep using
        DEXTube while it finishes.
      </p>
      <UploadForm maxBytes={config.uploads.maxBytes} acceptedFormats={acceptedFormatsSummary()} />
    </div>
  );
}
