import { describe, expect, it } from "vitest";
import {
  cuidSchema,
  emailSchema,
  handleSchema,
  loginSchema,
  normalizeEmail,
  passwordSchema,
  registerSchema,
  safeUrlSchema,
  tagSchema,
  usernameSchema,
} from "@/lib/validation";

describe("validation schemas", () => {
  describe("registerSchema", () => {
    const valid = {
      username: "ada_l",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      password: "CorrectHorse1",
    };

    it("accepts a well-formed registration", () => {
      expect(registerSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects a short password", () => {
      const result = registerSchema.safeParse({ ...valid, password: "short1A" });
      expect(result.success).toBe(false);
    });

    it("requires a number in the password", () => {
      expect(passwordSchema.safeParse("NoNumbersHere").success).toBe(false);
      expect(passwordSchema.safeParse("HasNumber1Here").success).toBe(true);
    });

    it("rejects an invalid email", () => {
      expect(registerSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    });

    it("rejects a username that starts with a digit", () => {
      expect(usernameSchema.safeParse("1ada").success).toBe(false);
      expect(usernameSchema.safeParse("ada").success).toBe(true);
    });
  });

  describe("handleSchema", () => {
    it("lowercases and trims a handle", () => {
      expect(handleSchema.parse("  Ada-L  ")).toBe("ada-l");
    });
    it("accepts uppercase but normalises it, and rejects symbols", () => {
      expect(handleSchema.safeParse("Ada").success).toBe(true);
      expect(handleSchema.parse("Ada")).toBe("ada");
      expect(handleSchema.safeParse("ada!").success).toBe(false);
    });
  });

  describe("loginSchema", () => {
    it("accepts a username or an email as the identifier", () => {
      expect(loginSchema.safeParse({ identifier: "ada", password: "x" }).success).toBe(true);
      expect(loginSchema.safeParse({ identifier: "ada@example.com", password: "x" }).success).toBe(true);
    });
    it("rejects a missing identifier", () => {
      expect(loginSchema.safeParse({ password: "x" }).success).toBe(false);
    });
  });

  describe("safeUrlSchema", () => {
    it("accepts http and https", () => {
      expect(safeUrlSchema.safeParse("https://example.com/a").success).toBe(true);
      expect(safeUrlSchema.safeParse("http://localhost:3000").success).toBe(true);
    });
    it("rejects script and data schemes", () => {
      expect(safeUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
      expect(safeUrlSchema.safeParse("data:text/html,<script>").success).toBe(false);
    });
  });

  describe("misc primitives", () => {
    it("rejects tags containing markup characters", () => {
      expect(tagSchema.safeParse("charming").success).toBe(true);
      expect(tagSchema.safeParse("<b>bold</b>").success).toBe(false);
      expect(tagSchema.safeParse("#hashtag").success).toBe(false);
    });

    it("validates cuid-like identifiers", () => {
      expect(cuidSchema.safeParse("cmvco0asj0000t6jbztk9jioh").success).toBe(true);
      expect(cuidSchema.safeParse("short").success).toBe(false);
      expect(cuidSchema.safeParse("has spaces").success).toBe(false);
    });

    it("trims an email and normaliseEmail lowercases it", () => {
      expect(emailSchema.parse("  ada@example.com ")).toBe("ada@example.com");
      expect(normalizeEmail("  ADA@Example.COM ")).toBe("ada@example.com");
    });
  });
});
