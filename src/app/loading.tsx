/** Renders nothing but keeps the app shell height correct during streaming. */
export default function Loading() {
  return <div style={{ minHeight: "60vh" }} />;
}
