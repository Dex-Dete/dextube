/**
 * Connector registry.
 *
 * The admin UI and the import service never import a specific connector: they ask
 * this module for the one that fits the address the operator pasted. Adding an
 * authorized provider later means adding a module and one line here — the
 * service, the routes, the audit trail and the UI are provider-agnostic.
 */
import "server-only";
import type { ImportConnectorKind } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { creatorExportConnector } from "./creator-export";
import type { MediaResolver, MetadataConnector } from "./types";
import { youtubeConnector } from "./youtube";

const CONNECTORS: readonly MetadataConnector[] = [youtubeConnector, creatorExportConnector];

/** Every connector, for the UI's "what can I import from?" table. */
export function listConnectors(): readonly MetadataConnector[] {
  return CONNECTORS;
}

export function getConnector(kind: ImportConnectorKind): MetadataConnector {
  const found = CONNECTORS.find((connector) => connector.kind === kind);
  if (!found) {
    throw new AppError("BAD_REQUEST", `No connector handles import kind "${kind}".`);
  }
  return found;
}

/**
 * Chooses a connector for a pasted address.
 *
 * A creator export is a local path, so it is tried only when the input looks like
 * one (no scheme, or a `file:`-free relative path) — anything that looks like an
 * http(s) address goes to the metadata connectors, which enforce the allowlist.
 */
export function connectorForInput(input: string): MetadataConnector {
  const trimmed = input.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "Enter a channel, playlist or export path.");
  if (/^https?:\/\//i.test(trimmed)) {
    if (/youtube\.com|youtu\.be/i.test(trimmed)) return youtubeConnector;
    throw new AppError(
      "VALIDATION_FAILED",
      "DEXTube only accepts YouTube channel/playlist URLs or an authorized creator export. " +
        "Other providers need a connector that documents its authorization model.",
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new AppError("VALIDATION_FAILED", "Only https:// URLs and local export paths are accepted.");
  }
  return creatorExportConnector;
}

/** The resolver that may supply bytes for a connector, when one exists. */
export function mediaResolverFor(connector: MetadataConnector): MediaResolver | null {
  return connector.canSupplyMedia ? (connector as unknown as MediaResolver) : null;
}
