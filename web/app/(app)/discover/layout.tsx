// Discover segment layout: renders the page (`children`) plus a parallel
// `@modal` slot. The slot is normally empty (its default.tsx returns null); an
// in-app <Link href="/event/[id]"> originating from /discover is caught by the
// `@modal/(.)event/[id]` interceptor and rendered there as a Dialog overlay,
// giving the modal feel while the URL becomes a shareable /event/[id]. A direct
// load / refresh / shared link bypasses the interceptor and hits the real
// /event/[id] page (full EventPageScreen).
export default function DiscoverLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
