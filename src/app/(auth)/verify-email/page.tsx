import type { Metadata } from "next";
import { VerifyEmailPanel } from "./VerifyEmailPanel";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return <VerifyEmailPanel />;
}
