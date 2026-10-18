/**
 * Shared validation schemas (zod).
 *
 * These are the single source of truth for input shape. Route handlers always
 * validate here before touching the database, so services can assume
 * well-formed input. Client forms import the same schemas where feasible so
 * the two never drift.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ primitives */

/** 3–30 chars, letters/digits/underscore/dash, must start with a letter. */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters.")
  .max(30, "Username must be at most 30 characters.")
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Use letters, numbers, dashes or underscores; start with a letter.");

/** Channel handles are the public @name; slightly stricter than usernames. */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Handle must be at least 3 characters.")
  .max(30, "Handle must be at most 30 characters.")
  .regex(/^[a-z][a-z0-9_-]*$/, "Use lowercase letters, numbers, dashes or underscores; start with a letter.");

export const emailSchema = z
  .string()
  .trim()
  .min(3, "Enter your email address.")
  .max(254, "Email address is too long.")
  .email("Enter a valid email address.");

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters.")
  .max(200, "Password must be at most 200 characters.")
  .refine((v) => /[a-z]/.test(v) || /[^\x00-\x7F]/.test(v), "Include a lowercase letter.")
  .refine((v) => /[A-Z]/.test(v) || /[^\x00-\x7F]/.test(v), "Include an uppercase letter.")
  .refine((v) => /[0-9]/.test(v), "Include a number.");

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a display name.")
  .max(60, "Display name must be at most 60 characters.");

export const visibilitySchema = z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]);
export const listVisibilitySchema = z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]);
export const reactionSchema = z.enum(["LIKE", "DISLIKE"]);

export const cuidSchema = z
  .string()
  .trim()
  .min(10, "Invalid identifier.")
  .max(64, "Invalid identifier.")
  .regex(/^[a-z0-9]+$/i, "Invalid identifier.");

/** http(s) only — blocks javascript:, data: and other scheme abuse. */
export const safeUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a valid http(s) URL.");

export const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^<>#\s][^<>#]*$/, "Tags cannot contain <, > or #.");

/* ------------------------------------------------------------------- accounts */

export const registerSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema,
  password: passwordSchema,
  /** Optional cold-start interests captured on the sign-up screen. */
  interests: z.array(tagSchema).max(12).optional(),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(3, "Enter your username or email.").max(254),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(16, "This reset link is invalid.").max(256),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({ token: z.string().min(16).max(256) });

export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  bio: z.string().trim().max(1000, "Bio must be at most 1000 characters.").optional(),
  username: usernameSchema.optional(),
});

export const updateSettingsSchema = z.object({
  saveWatchHistory: z.boolean().optional(),
  showLikesPublicly: z.boolean().optional(),
  /** Client-side playback preference; stored in localStorage, echoed for API parity. */
  autoplayNext: z.boolean().optional(),
  reduceDataUsage: z.boolean().optional(),
  notifyOnNewVideo: z.boolean().optional(),
  notifyOnComments: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1, "Enter your password to confirm."),
  confirm: z.literal("DELETE", { message: 'Type DELETE to confirm.' }),
});

/* ------------------------------------------------------------------- channels */

export const createChannelSchema = z.object({
  handle: handleSchema,
  name: z.string().trim().min(1, "Enter a channel name.").max(80),
  description: z.string().trim().max(2000, "Description must be at most 2000 characters.").optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(5000).optional(),
  handle: handleSchema.optional(),
  layout: z
    .object({
      /** Ordered list of section keys shown on the channel page. */
      sections: z.array(z.enum(["featured", "videos", "shorts", "playlists", "about"])).max(5).optional(),
    })
    .optional(),
});

/* --------------------------------------------------------------------- videos */

export const videoCategories = [
  "Film & Animation",
  "Autos & Vehicles",
  "Music",
  "Pets & Animals",
  "Sports",
  "Travel & Events",
  "Gaming",
  "People & Blogs",
  "Comedy",
  "Entertainment",
  "News & Politics",
  "Howto & Style",
  "Education",
  "Science & Technology",
  "Nonprofits & Activism",
] as const;

export const categorySchema = z.enum(videoCategories);

export const initiateUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive("File size must be greater than zero.")
    .max(64 * 1024 * 1024 * 1024, "File is too large."),
  mimeType: z.string().trim().min(1).max(120),
});

export const updateVideoSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120, "Title must be at most 120 characters.").optional(),
  description: z.string().trim().max(20000, "Description is too long.").optional(),
  visibility: visibilitySchema.optional(),
  category: categorySchema.optional(),
  tags: z.array(tagSchema).max(20, "Use at most 20 tags.").optional(),
  language: z.string().trim().min(2).max(12).optional(),
  allowComments: z.boolean().optional(),
  madeForKids: z.boolean().optional(),
  thumbnailTimeSec: z.number().min(0).max(86400).optional(),
});

export const publishVideoSchema = z.object({
  visibility: visibilitySchema.default("PUBLIC"),
  publishAt: z.string().datetime().optional(),
});

/* ------------------------------------------------------------------- comments */

export const createCommentSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(4000, "Comments are limited to 4000 characters."),
  parentId: cuidSchema.optional(),
});

export const updateCommentSchema = z.object({
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

export const commentSortSchema = z.enum(["top", "newest"]);

export const reportSchema = z.object({
  reason: z.enum(["spam", "harassment", "misinformation", "copyright", "sexual", "violence", "other"]),
  detail: z.string().trim().max(1000).optional(),
});

/* ------------------------------------------------------------------ playlists */

export const createPlaylistSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120),
  description: z.string().trim().max(2000).optional(),
  visibility: listVisibilitySchema.default("PRIVATE"),
});

export const updatePlaylistSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  visibility: listVisibilitySchema.optional(),
  /** Full ordered list of video ids — used for reordering. */
  itemOrder: z.array(cuidSchema).max(500).optional(),
});

/* -------------------------------------------------------------------- queries */

export const paginationSchema = z.object({
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

export const feedQuerySchema = paginationSchema.extend({
  tab: z.enum(["home", "subscriptions", "trending", "shorts"]).default("home"),
  category: z.string().trim().max(60).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().max(120).default(""),
  type: z.enum(["all", "video", "channel", "playlist", "short"]).default("all"),
  duration: z.enum(["any", "short", "medium", "long"]).default("any"),
  sort: z.enum(["relevance", "date", "views"]).default("relevance"),
  cursor: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(20),
});

export const analyticsQuerySchema = z.object({
  range: z.enum(["7d", "28d", "90d", "365d"]).default("28d"),
});

/* -------------------------------------------------------------------- helpers */

/** Normalises an email for uniqueness checks: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Strips control characters and collapses runs of whitespace. */
export function normalizeText(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ").trim();
}
